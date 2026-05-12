/* ═══════════════════════════════════════════════════════════════
   XmrRelayWS — WebSocket client for the xmr.irish relay (M1)
   PATCHED: restBase() now uses /api/xmr always (Vercel serverless
   bridge) instead of relay.xmr.irish which is not yet deployed.
   When relay.xmr.irish is live, update defaultUrl() and restBase()
   to re-enable direct relay connection and real-time WS push.
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
    'use strict';

    var FEE_TIERS = [
        { key: 'stuck',    max: 1,        color: '#444444', label: 'STUCK'    },
        { key: 'economy',  max: 5,        color: '#3D8EFF', label: 'ECONOMY'  },
        { key: 'normal',   max: 20,       color: '#00C97A', label: 'NORMAL'   },
        { key: 'fast',     max: 80,       color: '#F26822', label: 'FAST'     },
        { key: 'priority', max: Infinity, color: '#FF4455', label: 'PRIORITY' }
    ];

    function classify(feePerByte) {
        var r = Number(feePerByte) || 0;
        for (var i = 0; i < FEE_TIERS.length; i++) {
            if (r <= FEE_TIERS[i].max) return FEE_TIERS[i];
        }
        return FEE_TIERS[FEE_TIERS.length - 1];
    }

    function tierByKey(key) {
        for (var i = 0; i < FEE_TIERS.length; i++) if (FEE_TIERS[i].key === key) return FEE_TIERS[i];
        return FEE_TIERS[2];
    }

    /* ── Constructor ── */
    function XmrRelayWS(opts) {
        opts = opts || {};
        this.url     = opts.url  || XmrRelayWS.defaultUrl();
        this.want    = opts.want || ['mempool', 'blocks', 'fees', 'network'];
        this.debug   = !!opts.debug;
        this.ws      = null;
        this.state   = 'offline';
        this.backoff = 2000;
        this.maxBackoff = 30000;
        this.listeners  = {};
        this._reconnectTimer  = null;
        this._heartbeatTimer  = null;
        this._lastFrameAt     = 0;
        this._closed          = false;

        /* ─── POLLING FALLBACK ───────────────────────────────────────
           When no relay WS is available we poll the REST bridge on a
           fixed interval so all panels still receive live data.     */
        this._pollTimer   = null;
        this._pollMs      = 15000;   // 15 s between REST polls
        this._polledOnce  = false;
    }

    /* ── PATCH: always use the Vercel serverless bridge ── */
    XmrRelayWS.defaultUrl = function () {
        /* When relay.xmr.irish is running, change this back to:
           return 'wss://relay.xmr.irish/ws';               */
        return null;   // null = WS disabled, polling-only mode
    };

    /* ── PATCH: REST base always points at the Vercel function ── */
    function restBase() {
        return '/api/xmr';
    }

    function restGet(path) {
        return fetch(restBase() + path, {
            headers: { 'accept': 'application/json' }
        }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        });
    }

    /* ── on / off / _emit / _setState ── */
    XmrRelayWS.prototype.on = function (type, fn) {
        if (!this.listeners[type]) this.listeners[type] = [];
        this.listeners[type].push(fn);
        return this;
    };
    XmrRelayWS.prototype.off = function (type, fn) {
        var arr = this.listeners[type];
        if (!arr) return this;
        var idx = arr.indexOf(fn);
        if (idx !== -1) arr.splice(idx, 1);
        return this;
    };
    XmrRelayWS.prototype._emit = function (type, payload) {
        var arr = this.listeners[type] || [];
        for (var i = 0; i < arr.length; i++) {
            try { arr[i](payload); }
            catch (e) { if (this.debug) console.warn('[XmrRelayWS]', type, e); }
        }
    };
    XmrRelayWS.prototype._setState = function (next) {
        if (this.state === next) return;
        this.state = next;
        this._emit('state', next);
    };

    /* ── connect: tries WS first, falls back to polling ── */
    XmrRelayWS.prototype.connect = function () {
        this._closed = false;

        if (this.url) {
            this._connectWS();
        } else {
            /* No relay URL configured — go straight to polling */
            this._setState('polling');
            this._startPolling();
        }
        return this;
    };

    XmrRelayWS.prototype._connectWS = function () {
        var self = this;
        this._setState('connecting');
        try {
            this.ws = new WebSocket(this.url);
        } catch (e) {
            if (this.debug) console.warn('[XmrRelayWS] WS ctor threw', e);
            this._fallbackToPolling();
            return;
        }

        this.ws.onopen = function () {
            self._setState('live');
            self.backoff = 2000;
            self._lastFrameAt = Date.now();
            self._send({ action: 'want', data: self.want });
            self._startHeartbeat();
            /* Once WS is live, polling is redundant */
            self._stopPolling();
        };

        this.ws.onmessage = function (e) {
            self._lastFrameAt = Date.now();
            var msg;
            try { msg = JSON.parse(e.data); } catch (_) { return; }
            if (!msg || typeof msg.type !== 'string') return;
            if (self.debug) console.log('[XmrRelayWS] <-', msg.type);
            if (msg.type === 'pong') return;
            self._emit(msg.type, msg.data !== undefined ? msg.data : msg);
        };

        this.ws.onclose = function () {
            self._stopHeartbeat();
            if (self._closed) { self._setState('offline'); return; }
            /* WS closed — schedule reconnect AND start polling so the
               UI keeps refreshing during the reconnect back-off window */
            self._startPolling();
            self._scheduleReconnect();
        };

        this.ws.onerror = function () {
            if (self.debug) console.warn('[XmrRelayWS] socket error — falling back to polling');
            self._fallbackToPolling();
        };
    };

    XmrRelayWS.prototype._fallbackToPolling = function () {
        this._setState('polling');
        this._startPolling();
        /* Retry WS after maxBackoff so we pick it up if relay comes online later */
        var self = this;
        if (this.url) {
            setTimeout(function () {
                if (!self._closed && self.state !== 'live') self._connectWS();
            }, this.maxBackoff);
        }
    };

    /* ── Polling loop ── */
    XmrRelayWS.prototype._startPolling = function () {
        if (this._pollTimer) return;           // already running
        var self = this;

        function doPoll() {
            if (self._closed) return;
            self._poll().catch(function (e) {
                if (self.debug) console.warn('[XmrRelayWS] poll error', e);
            });
        }

        doPoll();  /* immediate first poll */
        self._pollTimer = setInterval(doPoll, self._pollMs);
    };

    XmrRelayWS.prototype._stopPolling = function () {
        if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    };

    XmrRelayWS.prototype._poll = function () {
        var self = this;
        return restGet('/mempool').then(function (data) {
            /* First successful poll — transition to 'live' so the connection
               indicator goes green and _onWsState cancels any fallback timer. */
            if (!self._polledOnce) {
                self._polledOnce = true;
                self._setState('live');
            }
            /* Synthesize the same events the WS relay would push */
            self._emit('mempool-update', data);
            if (data && data.fee_histogram) {
                var feeArr = data.fee_histogram.map(function (b) { return b.fee_rate_min; });
                self._emit('fee-update', { tiers: feeArr, timestamp: Date.now() });
            }
        }).then(function () {
            return restGet('/network');
        }).then(function (netData) {
            if (netData) self._emit('network-update', netData);
        }).catch(function (e) {
            /* Poll failed — go offline so fallback (MoneroNetwork) can arm */
            if (self._polledOnce) self._setState('offline');
        });
    };

    /* ── WebSocket helpers ── */
    XmrRelayWS.prototype._send = function (obj) {
        if (!this.ws || this.ws.readyState !== 1) return false;
        try { this.ws.send(JSON.stringify(obj)); return true; }
        catch (_) { return false; }
    };

    XmrRelayWS.prototype._scheduleReconnect = function () {
        var self = this;
        if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
        var delay = this.backoff;
        this.backoff = Math.min(Math.round(this.backoff * 2), this.maxBackoff);
        this._reconnectTimer = setTimeout(function () {
            if (!self._closed) self._connectWS();
        }, delay);
    };

    XmrRelayWS.prototype._startHeartbeat = function () {
        var self = this;
        this._stopHeartbeat();
        this._heartbeatTimer = setInterval(function () {
            if (Date.now() - self._lastFrameAt > 45000) {
                try { self.ws && self.ws.close(); } catch (_) {}
                return;
            }
            self._send({ action: 'ping' });
        }, 25000);
    };
    XmrRelayWS.prototype._stopHeartbeat = function () {
        if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    };

    XmrRelayWS.prototype.close = function () {
        this._closed = true;
        this._stopHeartbeat();
        this._stopPolling();
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        try { this.ws && this.ws.close(); } catch (_) {}
        this._setState('offline');
    };

    XmrRelayWS.prototype.track   = function (txid) { return this._send({ action: 'track-tx',   txid: txid }); };
    XmrRelayWS.prototype.untrack = function (txid) { return this._send({ action: 'untrack-tx', txid: txid }); };

    /* ── REST helpers ── */
    XmrRelayWS.prototype.fetchMempool   = function ()      { return restGet('/mempool'); };
    XmrRelayWS.prototype.fetchFees      = function ()      { return restGet('/mempool/fees'); };
    XmrRelayWS.prototype.fetchProjected = function ()      { return restGet('/mempool/projected'); };
    XmrRelayWS.prototype.fetchRecent    = function (limit) { return restGet('/mempool/recent?limit=' + (limit || 20)); };

    XmrRelayWS.prototype.fetchNetwork    = function ()      { return restGet('/network'); };
    XmrRelayWS.prototype.fetchHashrate   = function (range) { return restGet('/network/hashrate?range=' + (range || '7d')); };
    XmrRelayWS.prototype.fetchDifficulty = function (range) { return restGet('/network/difficulty?range=' + (range || '7d')); };
    XmrRelayWS.prototype.fetchPools      = function ()      { return restGet('/mining/pools'); };
    XmrRelayWS.prototype.fetchEmission   = function ()      { return restGet('/emission'); };

    /* ── Status helpers for connection indicator ── */
    XmrRelayWS.prototype.isLive    = function () { return this.state === 'live'; };
    XmrRelayWS.prototype.isPolling = function () { return this.state === 'polling'; };

    /* ── Static exports ── */
    XmrRelayWS.FEE_TIERS = FEE_TIERS;
    XmrRelayWS.classify  = classify;
    XmrRelayWS.tierByKey = tierByKey;

    global.XmrRelayWS = XmrRelayWS;
})(window);
