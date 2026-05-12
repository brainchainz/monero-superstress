/* mempool-block-parade.js — mempool.space-mirror block parade.
   Pending blocks on the LEFT of a center divider, confirmed blocks on the
   RIGHT with the newest adjacent to the divider. Tracker overlays (arrow,
   10-conf dashed line) live in a sibling .bp-overlay so they are NOT
   clipped by the .bp-wrap overflow context. Only genuinely new blocks
   animate in. */
(function (global) {
    'use strict';

    var REFRESH_MS    = 15000;
    var MAX_CONFIRMED = 18;   /* 9 confirming + 9 unlocked past the 10-conf line for visible flow */
    var PENDING_COUNT = 2;
    var CONF_REQ      = 10;
    var AVG_BLOCK_SEC = 120;   /* Monero ~2 min */

    function fmtAgo(ts) {
        if (!ts) return '—';
        var s = Math.max(0, Math.floor(Date.now() / 1000) - Number(ts));
        if (s < 60)   return s + 's ago';
        if (s < 3600) return Math.floor(s / 60) + 'm ago';
        return Math.floor(s / 3600) + 'h ago';
    }

    function fmtBytes(b) {
        if (!b) return '—';
        if (b < 1024) return b + ' B';
        return (b / 1024).toFixed(1) + ' KB';
    }

    function shortTxid(t) {
        if (!t) return '…';
        return t.slice(0, 8) + '…' + t.slice(-4);
    }

    /* Map an avg fee rate (XMR per kB, rough) to one of four tiers.
       Thresholds are generous because Monero mempool is usually one-tier. */
    function feeTier(rate) {
        if (!rate || rate <= 0) return 'med';
        if (rate < 20000)       return 'low';
        if (rate < 80000)       return 'med';
        if (rate < 300000)      return 'high';
        return 'vhigh';
    }

    /* Monero unlocks AT 10 confirmations. Zone is now derived from confs
       (height delta to tip), not array index — see _makeConfirmedBlock. */
    function fillHeightForTxCount(n) {
        n = Number(n) || 0;
        if (n <= 10) return 75;
        if (n <= 50) return 85;
        return 95;
    }

    function BlockParade(container, onBlockClick) {
        this.container    = container;
        this.onBlockClick = onBlockClick || null;
        this.blocks       = [];
        this.pending      = null;
        this.topHeight    = 0;
        this._timer       = null;
        this._confirmedNodes = Object.create(null);
        this._resizeTimer = 0;
        this._resizeHandler = null;
        this._listeners = [];
        this._destroyed = false;
        this._host = null;

        /* Tracking state */
        this.trackedTxid      = null;
        this.trackedBlock     = null;
        this.trackedConfs     = 0;
        this.trackedStatus    = 'none';   /* none | pending | confirming | confirmed */
        this._highlightedBlock = null;     /* purely visual "point at this block" */

        this._inject();
        this.refresh();
    }

    BlockParade.prototype.setTracked = function (txid, blockHeight, currentTip) {
        this.trackedTxid  = txid;
        this.trackedBlock = blockHeight || null;
        if (!blockHeight) {
            this.trackedConfs  = 0;
            this.trackedStatus = 'pending';
        } else {
            var tip = currentTip || (this.blocks[0] ? this.blocks[0].height : blockHeight);
            this.trackedConfs  = Math.max(0, tip - blockHeight + 1);
            this.trackedStatus = this.trackedConfs >= CONF_REQ ? 'confirmed' : 'confirming';
        }
        this.render();
        var self = this;
        requestAnimationFrame(function () { self._scrollToTrackedBlock(); });
        /* If blocks haven't loaded yet, refresh now so the arrow doesn't sit
           hidden for ~15s until the next interval tick. Use the heavy path
           because we genuinely need block data, not just a tip ping. */
        if (!this.blocks || this.blocks.length === 0) {
            this._fullRefresh();
        }
    };

    BlockParade.prototype.clearTracked = function () {
        this.trackedTxid   = null;
        this.trackedBlock  = null;
        this.trackedConfs  = 0;
        this.trackedStatus = 'none';
        this._lastArrowState = null;
        this.render();
    };

    /* Purely visual "point the arrow at this block" — independent of TX
       lifecycle tracking. Used when navigating to a block detail view. */
    BlockParade.prototype.highlightBlock = function (height) {
        this._highlightedBlock = height ? Number(height) : null;
        this._positionOverlays();
        var self = this;
        requestAnimationFrame(function () { self._scrollToTrackedBlock(); });
    };

    BlockParade.prototype.clearHighlight = function () {
        this._highlightedBlock = null;
        this._positionOverlays();
    };

    BlockParade.prototype.start = function () {
        var self = this;
        if (this._timer) return;
        /* Initial blocks load — populate the strip. Subsequent ticks are
           lightweight tip polls; they only trigger a full refresh when the
           chain advances. */
        this._fullRefresh();
        this._timer = setInterval(function () { self._tipPoll(); }, REFRESH_MS);
    };

    BlockParade.prototype.stop = function () {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    };

    BlockParade.prototype._on = function (target, type, handler, options) {
        target.addEventListener(type, handler, options);
        this._listeners.push({ target: target, type: type, handler: handler, options: options });
    };

    BlockParade.prototype.destroy = function () {
        this._destroyed = true;
        this.stop();
        if (this._resizeTimer) { clearTimeout(this._resizeTimer); this._resizeTimer = 0; }
        if (this._scrollEndTimer) { clearTimeout(this._scrollEndTimer); this._scrollEndTimer = 0; }
        if (this._dragJustEndedTimer) { clearTimeout(this._dragJustEndedTimer); this._dragJustEndedTimer = 0; }
        for (var i = 0; i < this._listeners.length; i++) {
            var l = this._listeners[i];
            try { l.target.removeEventListener(l.type, l.handler, l.options); } catch (_) {}
        }
        this._listeners = [];
        if (this._host && this._host.parentNode) this._host.parentNode.removeChild(this._host);
        this._host = null;
        this.onBlockClick = null;
        this._confirmedNodes = Object.create(null);
    };

    BlockParade.prototype._inject = function () {
        this._injectCSS();

        var c = this.container;
        /* Status bar */
        var statusBar = document.createElement('div');
        statusBar.className = 'bp-status-bar';
        statusBar.hidden = true;

        /* Outer positioning context */
        var outer = document.createElement('div');
        outer.className = 'bp-outer';

        var wrap = document.createElement('div');
        wrap.className = 'bp-wrap';

        var pendingGroup = document.createElement('div');
        pendingGroup.className = 'bp-pending-group';
        var divider = document.createElement('div');
        divider.className = 'bp-divider';
        var confirmedGroup = document.createElement('div');
        confirmedGroup.className = 'bp-confirmed-group';

        wrap.appendChild(pendingGroup);
        wrap.appendChild(divider);
        wrap.appendChild(confirmedGroup);

        /* Overlay — absolute, sibling of wrap, escapes overflow clipping */
        var overlay = document.createElement('div');
        overlay.className = 'bp-overlay';
        overlay.innerHTML =
            '<div class="bp-arrow" hidden>' +
              '<div class="bp-arrow-line"></div>' +
              '<div class="bp-arrow-tri"></div>' +
              '<div class="bp-arrow-label"></div>' +
            '</div>' +
            '<div class="bp-dotline" hidden>' +
              '<span class="bp-dotline-label">10 CONF · UNLOCK</span>' +
            '</div>' +
            '<div class="bp-offscreen-hint" hidden></div>';

        outer.appendChild(wrap);
        var baseline = document.createElement('div');
        baseline.className = 'bp-baseline';
        outer.appendChild(baseline);
        outer.appendChild(overlay);

        /* Wrap status-bar + outer in a shared .bp-host so sticky positioning
           can pin both together. Prepend into the container so the parade is
           the FIRST child of #mp-panel-explorer (the explorer panel renders
           ~2,000px of tx detail below it otherwise). */
        var host = document.createElement('div');
        host.className = 'bp-host';
        host.appendChild(statusBar);
        host.appendChild(outer);
        c.insertBefore(host, c.firstChild);
        this._host = host;

        var self = this;
        this._resizeHandler = function () {
            if (self._resizeTimer) clearTimeout(self._resizeTimer);
            self._resizeTimer = setTimeout(function () {
                self._positionOverlays();
                updateEdgeFades();
            }, 100);
        };
        this._on(window, 'resize', this._resizeHandler);

        function updateEdgeFades() {
            var atStart = wrap.scrollLeft <= 1;
            var atEnd   = wrap.scrollLeft + wrap.clientWidth >= wrap.scrollWidth - 1;
            outer.classList.toggle('is-at-scroll-start', atStart);
            outer.classList.toggle('is-at-scroll-end',   atEnd);
        }
        self._updateEdgeFades = updateEdgeFades;

        /* Scroll listener — keeps overlays glued to their blocks during user
           scroll (zero-lag via is-instant), then re-enables transitions ~80ms
           after scroll settles. Edge fades update too. */
        self._scrollEndTimer = 0;
        this._on(wrap, 'scroll', function () {
            var overlays = self.container.querySelectorAll('.bp-arrow, .bp-dotline, .bp-offscreen-hint');
            for (var i = 0; i < overlays.length; i++) overlays[i].classList.add('is-instant');
            self._positionOverlays();
            if (self._scrollEndTimer) clearTimeout(self._scrollEndTimer);
            self._scrollEndTimer = setTimeout(function () {
                for (var j = 0; j < overlays.length; j++) overlays[j].classList.remove('is-instant');
            }, 80);
            updateEdgeFades();
        }, { passive: true });

        /* Wheel-to-horizontal — vertical wheel rotation scrolls the strip
           horizontally while the cursor is over it. Page scroll resumes when
           the strip hits a boundary. */
        this._on(wrap, 'wheel', function (e) {
            var delta = e.deltaY || e.deltaX;
            if (Math.abs(delta) < 1) return;
            var atStart = wrap.scrollLeft <= 0;
            var atEnd   = wrap.scrollLeft + wrap.clientWidth >= wrap.scrollWidth - 1;
            if ((delta > 0 && atEnd) || (delta < 0 && atStart)) return;
            e.preventDefault();
            wrap.scrollLeft += delta;
        }, { passive: false });

        /* Click-and-drag panning — mouse users can grab the strip. A drag of
           >4px suppresses the resulting click so block navigation isn't
           triggered when the user just wanted to pan. */
        var dragState = { active: false, startX: 0, startScroll: 0, moved: false };
        var dragJustEnded = false;
        self._dragJustEndedTimer = 0;

        this._on(wrap, 'mousedown', function (e) {
            if (e.button !== 0) return;
            dragState.active = true;
            dragState.startX = e.pageX;
            dragState.startScroll = wrap.scrollLeft;
            dragState.moved = false;
            wrap.classList.add('is-grabbing');
        });
        this._on(window, 'mousemove', function (e) {
            if (!dragState.active) return;
            var dx = e.pageX - dragState.startX;
            if (Math.abs(dx) > 4) dragState.moved = true;
            wrap.scrollLeft = dragState.startScroll - dx;
        });
        this._on(window, 'mouseup', function () {
            if (!dragState.active) return;
            dragState.active = false;
            wrap.classList.remove('is-grabbing');

            if (dragState.moved) {
                /* Mark "drag just ended" for one event-loop tick. The block click
                   handler reads this flag synchronously when it fires. After 50ms,
                   the flag clears so subsequent clicks behave normally. */
                dragJustEnded = true;
                if (self._dragJustEndedTimer) clearTimeout(self._dragJustEndedTimer);
                self._dragJustEndedTimer = setTimeout(function () { dragJustEnded = false; }, 50);
            }
        });

        /* Expose to the click handler defined later in _makeConfirmedBlock. */
        self._wasJustDragged = function () { return dragJustEnded; };

        /* Double-rAF — first frame batches with current layout, second frame
           reads post-layout dimensions for accurate edge-fade state. */
        requestAnimationFrame(function () {
            requestAnimationFrame(updateEdgeFades);
        });
    };

    BlockParade.prototype._injectCSS = function () {
        if (document.getElementById('bp-css')) return;
        var style = document.createElement('style');
        style.id = 'bp-css';
        style.textContent = [
            '.bp-outer{position:relative;overflow:visible}',
            '.bp-baseline{position:absolute;left:0;right:0;bottom:30px;border-bottom:1px dashed rgba(255,255,255,.12);pointer-events:none;z-index:0}',
            '.bp-outer::before,.bp-outer::after{content:"";position:absolute;top:0;bottom:0;width:32px;pointer-events:none;z-index:5;transition:opacity .25s}',
            '.bp-outer::before{left:0;background:linear-gradient(90deg,var(--surface-0) 0%,transparent 100%)}',
            '.bp-outer::after{right:0;background:linear-gradient(270deg,var(--surface-0) 0%,transparent 100%)}',
            '.bp-outer.is-at-scroll-start::before{opacity:0}',
            '.bp-outer.is-at-scroll-end::after{opacity:0}',
            '.bp-wrap{overflow-x:auto;overflow-y:visible;display:flex;align-items:flex-end;gap:6px;padding:4px 0 8px;cursor:grab;scroll-behavior:auto;scrollbar-color:rgba(255,102,0,.4) transparent;scrollbar-width:thin}',
            '.bp-wrap.is-grabbing{cursor:grabbing;user-select:none}',
            '.bp-wrap::-webkit-scrollbar{height:6px;background:transparent}',
            '.bp-wrap::-webkit-scrollbar-thumb{background:rgba(255,102,0,.35);border-radius:3px;transition:background .15s}',
            '.bp-wrap::-webkit-scrollbar-thumb:hover{background:rgba(255,102,0,.6)}',
            '.bp-wrap::-webkit-scrollbar-track{background:transparent}',
            '.bp-pending-group,.bp-confirmed-group{display:flex;gap:6px;flex:0 0 auto;align-items:flex-end}',
            '.bp-divider{flex:0 0 auto;width:1px;height:220px;background:var(--border-default);margin:0 10px;position:relative}',
            '.bp-divider::before{content:"\\2195";position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font:10px/1 "JetBrains Mono",monospace;color:var(--text-tertiary);background:var(--surface-0);padding:2px 1px}',

            /* Cell wrapper — holds height-above, block, pool-row */
            '.bp-cell{flex:0 0 128px;display:flex;flex-direction:column;gap:4px}',
            '.bp-height-above{font:700 11px/1 "JetBrains Mono",monospace;color:var(--blue);text-align:center}',
            '.bp-cell-pending .bp-height-above{color:var(--text-muted)}',
            '.bp-pool-row{display:flex;align-items:center;justify-content:center;gap:4px;min-height:12px;font:9px/1 "DM Mono",monospace;color:var(--text-muted)}',
            '.bp-pool-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}',
            '.bp-pool-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:110px}',

            /* Blocks — shared (3D slanted top-left corner via clip-path pseudos) */
            '.bp-block{position:relative;width:128px;min-height:200px;background:transparent;padding:10px 10px 8px;display:flex;flex-direction:column;overflow:visible;clip-path:polygon(14px 0,100% 0,100% 100%,0 100%,0 14px);transition:transform .15s}',
            '.bp-block::before{content:"";position:absolute;inset:0;border:1px solid var(--border-subtle);background:var(--surface-1);clip-path:polygon(14px 0,100% 0,100% 100%,0 100%,0 14px);transition:border-color .15s,background .15s,box-shadow .15s,transform .15s;z-index:1}',
            '.bp-block::after{content:"";position:absolute;top:0;left:0;width:20px;height:20px;background:linear-gradient(135deg,transparent 13px,var(--border-subtle) 13px,var(--border-subtle) 14.5px,transparent 14.5px);pointer-events:none;z-index:2;transition:background .15s}',
            '.bp-block > *{position:relative;z-index:3}',
            '.bp-block:hover::before{border-color:var(--border-default);transform:translateY(-1px)}',
            '.bp-block-new{animation:bp-slide-in .4s ease-out}',
            '@keyframes bp-slide-in{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:translateX(0)}}',
            '.bp-cell-confirmed{will-change:transform}',
            '.bp-cell.bp-pre-unlock-gap{margin-right:22px}',
            '.bp-confs-label{font:600 10px/1 "DM Mono",monospace;color:rgba(var(--zone-rgb), var(--zone-label));margin-bottom:4px;letter-spacing:.04em;text-align:center}',
            '.bp-confs-label span{font-weight:400;color:var(--text-tertiary);text-transform:uppercase;font-size:8px;margin-left:1px}',
            '.bp-cell-pending .bp-confs-label{display:none}',

            /* ── Zone color scheme — uniform orange, three saturation levels ── */
            '.bp-block.is-confirmed{cursor:pointer}',
            '.bp-cell.zone-pending     { --zone-rgb: 255, 102, 0; --zone-bg-hi: .06; --zone-bg-lo: .02; --zone-border: .45; --zone-fill-hi: .50; --zone-fill-lo: .22; --zone-glow: .12; --zone-edge: .55; --zone-label: .55; }',
            '.bp-cell.zone-confirming  { --zone-rgb: 255, 102, 0; --zone-bg-hi: .12; --zone-bg-lo: .04; --zone-border: .70; --zone-fill-hi: .80; --zone-fill-lo: .45; --zone-glow: .25; --zone-edge: .85; --zone-label: .90; }',
            '.bp-cell.zone-unlocked    { --zone-rgb: 255, 102, 0; --zone-bg-hi: .22; --zone-bg-lo: .10; --zone-border: .95; --zone-fill-hi: .98; --zone-fill-lo: .72; --zone-glow: .45; --zone-edge: 1.0; --zone-label: 1.0; }',

            '.bp-cell .bp-block::before{background:linear-gradient(180deg,rgba(var(--zone-rgb), var(--zone-bg-lo)),rgba(var(--zone-rgb), var(--zone-bg-hi)));border-color:rgba(var(--zone-rgb), var(--zone-border));box-shadow:0 0 3px rgba(var(--zone-rgb), calc(var(--zone-glow) * .5)),inset 0 0 0 1px rgba(var(--zone-rgb), calc(var(--zone-border) * .3))}',
            '.bp-cell .bp-block::after{background:linear-gradient(135deg,transparent 13px,rgba(var(--zone-rgb), var(--zone-edge)) 13px,rgba(var(--zone-rgb), var(--zone-edge)) 14.5px,transparent 14.5px)}',
            '.bp-cell .bp-block{box-shadow:0 0 0 0 rgba(var(--zone-rgb), 0),0 0 14px rgba(var(--zone-rgb), var(--zone-glow));transition:box-shadow .35s ease}',
            '.bp-cell:hover .bp-block{box-shadow:0 0 0 0 rgba(var(--zone-rgb), 0),0 0 22px rgba(var(--zone-rgb), calc(var(--zone-glow) + .10))}',
            '.bp-cell .bp-height-above{color:rgba(var(--zone-rgb), var(--zone-label))}',

            '.bp-fill-area{position:absolute;inset:8px 8px 36px 8px;pointer-events:none;z-index:1}',
            '.bp-fill-bar{position:absolute;bottom:0;left:0;right:0;border-radius:2px;background:linear-gradient(0deg,rgba(var(--zone-rgb), var(--zone-fill-hi)),rgba(var(--zone-rgb), var(--zone-fill-lo)));transition:height .9s cubic-bezier(.2,.8,.2,1);box-shadow:0 0 8px rgba(var(--zone-rgb), calc(var(--zone-glow) + .08))}',

            '.bp-content{position:relative;z-index:2;display:flex;flex-direction:column;height:100%;padding:10px 8px 8px;pointer-events:none}',
            '.bp-tx-count-big{font:700 16px/1 "JetBrains Mono",monospace;color:var(--text-primary);text-shadow:0 1px 2px rgba(0,0,0,.5);margin-bottom:4px}',
            '.bp-tx-count-big span{font:9px/1 "DM Mono",monospace;font-weight:400;color:var(--text-tertiary);letter-spacing:.08em;text-transform:uppercase;margin-left:2px}',
            '.bp-secondary-line{font:500 11px/1.2 "DM Mono",monospace;color:var(--text-secondary);text-shadow:0 1px 1px rgba(0,0,0,.4);margin-bottom:2px}',
            '.bp-secondary-line.bp-reward{color:rgba(255,255,255,.65)}',
            '.bp-age{margin-top:auto;font:9px/1 "DM Mono",monospace;color:var(--text-tertiary);text-shadow:0 1px 1px rgba(0,0,0,.4)}',
            '.bp-pending-marker{font:700 9px/1 "DM Mono",monospace;color:rgba(var(--zone-rgb), .85);letter-spacing:.12em;margin-bottom:4px}',
            '.bp-cell-pending.is-next-bright{--zone-fill-hi:.65;--zone-fill-lo:.35;--zone-glow:.15}',
            '.bp-cell-pending.is-far{opacity:.78}',

            /* Tracker overlay */
            '.bp-overlay{position:absolute;inset:0;overflow:visible;pointer-events:none}',
            '.bp-arrow{position:absolute;top:0;left:0;pointer-events:none;display:flex;flex-direction:column;align-items:center;gap:2px;will-change:transform;transition:transform 1.4s cubic-bezier(.45,.85,.35,1)}',
            '.bp-arrow[hidden]{display:none}',
            '.bp-arrow.is-instant{transition:none}',
            '.bp-arrow-line{width:1px;height:20px;background:repeating-linear-gradient(180deg,var(--blue) 0 2px,transparent 2px 4px)}',
            '.bp-arrow-tri{width:0;height:0;border:7px solid transparent;border-top:0;border-bottom:10px solid var(--blue);filter:drop-shadow(0 0 4px rgba(74,158,255,.7));transform:rotate(180deg)}',
            '.bp-arrow-label{font:700 9px/1 "DM Mono",monospace;color:var(--blue);letter-spacing:.1em;white-space:nowrap;padding:2px 6px;border:1px solid var(--blue);border-radius:3px;background:rgba(10,12,20,.75);margin-top:2px}',
            '.bp-arrow.is-confirmed .bp-arrow-line{background:repeating-linear-gradient(180deg,var(--grn) 0 2px,transparent 2px 4px)}',
            '.bp-arrow.is-confirmed .bp-arrow-tri{border-bottom-color:var(--grn);filter:drop-shadow(0 0 4px rgba(0,201,122,.7))}',
            '.bp-arrow.is-confirmed .bp-arrow-label{color:var(--grn);border-color:var(--grn)}',
            '.bp-arrow.is-pending .bp-arrow-line{background:repeating-linear-gradient(180deg,var(--gold) 0 2px,transparent 2px 4px)}',
            '.bp-arrow.is-pending .bp-arrow-tri{border-bottom-color:var(--gold);filter:drop-shadow(0 0 4px rgba(255,209,0,.7))}',
            '.bp-arrow.is-pending .bp-arrow-label{color:var(--gold);border-color:var(--gold)}',
            '.bp-arrow.is-highlight .bp-arrow-line{background:repeating-linear-gradient(180deg,var(--xmr) 0 2px,transparent 2px 4px)}',
            '.bp-arrow.is-highlight .bp-arrow-tri{border-bottom-color:var(--xmr);filter:drop-shadow(0 0 4px rgba(255,102,0,.7))}',
            '.bp-arrow.is-highlight .bp-arrow-label{color:var(--xmr);border-color:var(--xmr);box-shadow:0 0 10px rgba(255,102,0,.45)}',

            '.bp-dotline{position:absolute;top:0;left:0;bottom:0;border-left:2px dashed rgba(255,209,0,.55);will-change:transform;transition:transform 1.4s cubic-bezier(.45,.85,.35,1);pointer-events:none;width:0}',
            '.bp-dotline[hidden]{display:none}',
            '.bp-dotline.is-instant{transition:none}',
            '.bp-dotline-label{position:absolute;top:-22px;left:-28px;font:700 9px/1 "DM Mono",monospace;color:var(--gold);letter-spacing:.12em;white-space:nowrap;background:var(--surface-0);padding:3px 8px;border:1px solid rgba(255,209,0,.4);border-radius:3px;text-transform:uppercase;writing-mode:horizontal-tb;transform:none}',

            /* Status bar */
            '.bp-status-bar{display:flex;align-items:center;gap:8px;padding:7px 12px;margin-bottom:8px;border-radius:6px;font:10px/1 "DM Mono",monospace;flex-wrap:wrap}',
            '.bp-status-bar[hidden]{display:none}',
            '.bp-status-bar.bp-status-pending{background:rgba(255,209,0,.06);border:1px solid rgba(255,209,0,.25)}',
            '.bp-status-bar.bp-status-confirming{background:rgba(74,158,255,.06);border:1px solid rgba(74,158,255,.25)}',
            '.bp-status-bar.bp-status-confirmed{background:rgba(0,201,122,.06);border:1px solid rgba(0,201,122,.35)}',
            '.bp-status-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}',
            '.bp-dot-gold{background:var(--gold);box-shadow:0 0 4px var(--gold);animation:bp-pulse 2s ease-in-out infinite}',
            '.bp-dot-blue{background:var(--blue);box-shadow:0 0 4px var(--blue);animation:bp-pulse 1.5s ease-in-out infinite}',
            '.bp-dot-grn{background:var(--grn);box-shadow:0 0 4px var(--grn)}',
            '.bp-status-label{font-weight:700;color:var(--text-secondary);letter-spacing:.06em}',
            '.bp-status-sep{color:var(--text-tertiary)}',
            '.bp-status-msg{color:var(--text-primary);letter-spacing:.03em}',
            '.bp-status-need{color:var(--text-muted);font-size:9px;letter-spacing:.04em}',
            '.bp-status-clear{margin-left:auto;background:transparent;border:1px solid var(--border-subtle);color:var(--text-tertiary);font:10px/1 "DM Mono",monospace;padding:2px 7px;border-radius:3px;cursor:pointer;transition:color .15s,border-color .15s}',
            '.bp-status-clear:hover{color:var(--red);border-color:var(--red)}',
            '.bp-conf-bar{height:4px;width:60px;background:var(--surface-2);border-radius:2px;overflow:hidden}',
            '.bp-conf-fill{height:100%;background:var(--blue);border-radius:2px;transition:width .4s ease-out}',

            /* Sticky host so parade stays visible while scrolling a tx/block detail */
            '.bp-host{position:sticky;top:var(--nav-height,60px);z-index:30;background:var(--surface-0);padding:8px 12px 10px;margin:0 -12px 12px;border-bottom:1px solid var(--border-subtle)}',

            /* is-confirming mirrors the default blue tracking color (same as base) */

            /* Off-range hint — tracked/highlighted block not in visible range */
            '.bp-offscreen-hint{position:absolute;top:0;left:0;font:600 9px/1 "DM Mono",monospace;color:var(--text-tertiary);letter-spacing:.1em;text-transform:uppercase;white-space:nowrap;padding:4px 8px;border-radius:4px;background:var(--surface-2);border:1px solid var(--border-subtle);pointer-events:none;will-change:transform;transition:transform 1.4s cubic-bezier(.45,.85,.35,1)}',
            '.bp-offscreen-hint[hidden]{display:none}',
            '.bp-offscreen-hint.is-instant{transition:none}',
            '.bp-offscreen-hint.is-visible{color:var(--xmr);border-color:rgba(255,102,0,.3)}',

            '@keyframes bp-pulse{from{opacity:.55}to{opacity:1}}'
        ].join('');
        document.head.appendChild(style);
    };

    /* Lightweight tip poll. Most ticks. Only triggers a full refresh when
       the tip has advanced. Monero block time averages ~120s, so ~7 of every
       8 polls observe no advance and do nothing — drastically reducing the
       DOM churn that the user sees as "shimmering between renders". */
    BlockParade.prototype._tipPoll = function () {
        var self = this;
        fetch('/api/xmr?_p=tip', { headers: { accept: 'application/json' } })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
                if (!data || !data.height) return;
                var observedTip = Number(data.height);
                if (window._xmrDebug) {
                    console.log('[parade.tipPoll]', {
                        ts: new Date().toISOString().slice(11, 19),
                        observedTip: observedTip,
                        currentTip: self.topHeight,
                        advance: observedTip - self.topHeight
                    });
                }
                if (observedTip > self.topHeight) {
                    /* Tip advanced — do the full refresh + render. */
                    self._fullRefresh();
                }
                /* If observedTip < self.topHeight: tip hysteresis (Prompt I)
                   handles it — ignore. */
            })
            .catch(function () { /* network blip — try again next tick */ });
    };

    /* Public refresh() is now the tip poll. The 15s interval calls THIS,
       not the heavy blocks fetch. setTracked() and start() trigger the
       full path explicitly when needed. */
    BlockParade.prototype.refresh = function () {
        this._tipPoll();
    };

    BlockParade.prototype._fullRefresh = function () {
        var self = this;
        Promise.all([
            fetch('/api/xmr/blocks', { headers: { accept: 'application/json' } })
                .then(function (r) { return r.ok ? r.json() : []; })
                .catch(function () { return []; }),
            fetch('/api/xmr?_p=mempool', { headers: { accept: 'application/json' } })
                .then(function (r) { return r.ok ? r.json() : null; })
                .catch(function () { return null; })
        ]).then(function (res) {
            var blocks  = res[0] || [];
            var pending = res[1] || null;

            /* Tip hysteresis: never accept a regression. Multi-node API cascade
               can return out-of-sync tips; without this guard, confs flickers
               as tips oscillate between nodes (e.g. user sees 1↔2↔1↔2). */
            var newTip = blocks.length ? Number(blocks[0].height) : 0;
            if (newTip > 0 && self.topHeight > 0 && newTip < self.topHeight) {
                if (window._xmrDebug) {
                    console.warn('[parade.refresh] rejected tip regression:',
                        newTip, '<', self.topHeight);
                }
                /* Pending is volatile and not gated on tip — still update it. */
                self.pending = pending;
                self.render();
                return;
            }

            self.topHeight = newTip;
            /* Defensive sort: API should return newest-first, but in partial-failure
               cases (one upstream node returns 22 blocks at heights N..N-21, another
               returns 22 at N-1..N-22, and the cascade response is mixed) the array
               could surface out of order. Sort explicitly so this.blocks[0] is always
               the highest height. */
            self.blocks    = blocks.slice(0, MAX_CONFIRMED)
                .sort(function (a, b) { return Number(b.height) - Number(a.height); });
            self.pending   = pending;
            self._lastRefreshAt = Date.now();   /* used by debug logs */

            if (self.trackedBlock && self.blocks.length) {
                var tip = self.blocks[0].height;
                var newConfs = Math.max(0, tip - self.trackedBlock + 1);
                /* Confs hysteresis (defense-in-depth): if confs would go down,
                   ignore. Belt-and-suspenders the topHeight guard above. */
                if (newConfs >= self.trackedConfs) {
                    self.trackedConfs  = newConfs;
                    self.trackedStatus = self.trackedConfs >= CONF_REQ ? 'confirmed' : 'confirming';
                }
            }

            if (window._xmrDebug) {
                console.log('[parade.refresh]', {
                    ts: new Date().toISOString().slice(11, 19),
                    newTip: newTip,
                    blocks_count: blocks.length,
                    blocks_first3: blocks.slice(0, 3).map(function (b) {
                        return { h: b.height, ts: b.timestamp, txs: b.tx_count };
                    }),
                    trackedBlock: self.trackedBlock,
                    trackedConfs: self.trackedConfs
                });
            }

            self.render();
        });
    };

    BlockParade.prototype._renderStatusBar = function () {
        var bar = this.container.querySelector('.bp-status-bar');
        if (!bar) return;
        if (this.trackedStatus === 'none') {
            bar.hidden = true;
            bar.innerHTML = '';
            return;
        }
        bar.hidden = false;
        var self = this;
        var tx = shortTxid(this.trackedTxid);
        var cls, html;
        if (this.trackedStatus === 'pending') {
            cls = 'bp-status-pending';
            html =
                '<span class="bp-status-dot bp-dot-gold"></span>' +
                '<span class="bp-status-label">TRACKING ' + tx + '</span>' +
                '<span class="bp-status-sep">·</span>' +
                '<span class="bp-status-msg">⟳ UNCONFIRMED — awaiting block inclusion</span>' +
                '<button class="bp-status-clear" data-bp-clear title="Stop tracking">✕</button>';
        } else if (this.trackedStatus === 'confirming') {
            var need = CONF_REQ - this.trackedConfs;
            var pct  = Math.round((this.trackedConfs / CONF_REQ) * 100);
            cls = 'bp-status-confirming';
            html =
                '<span class="bp-status-dot bp-dot-blue"></span>' +
                '<span class="bp-status-label">TRACKING ' + tx + '</span>' +
                '<span class="bp-status-sep">·</span>' +
                '<span class="bp-status-msg">' + this.trackedConfs + '/10 CONFIRMATIONS</span>' +
                '<div class="bp-conf-bar"><div class="bp-conf-fill" style="width:' + pct + '%"></div></div>' +
                '<span class="bp-status-need">' + need + ' more block' + (need !== 1 ? 's' : '') + '</span>' +
                '<button class="bp-status-clear" data-bp-clear title="Stop tracking">✕</button>';
        } else {
            cls = 'bp-status-confirmed';
            html =
                '<span class="bp-status-dot bp-dot-grn"></span>' +
                '<span class="bp-status-label">TRACKING ' + tx + '</span>' +
                '<span class="bp-status-sep">·</span>' +
                '<span class="bp-status-msg">✓ FULLY CONFIRMED · ' + this.trackedConfs + ' CONFIRMATIONS</span>' +
                '<button class="bp-status-clear" data-bp-clear title="Stop tracking">✕</button>';
        }
        bar.className = 'bp-status-bar ' + cls;
        bar.innerHTML = html;
        var clr = bar.querySelector('[data-bp-clear]');
        if (clr) clr.addEventListener('click', function () { self.clearTracked(); });
    };

    BlockParade.prototype._makeConfirmedBlock = function (b, isNew, indexInBlocks) {
        /* Compute confs from height delta to tip — robust to gaps in
           this.blocks (which can occur if API failed to fetch some heights).
           Index-based confs were wrong as soon as any height was missing. */
        var confs = Math.max(1, this.topHeight - Number(b.height) + 1);
        var zone = confs >= 10 ? 'unlocked' : 'confirming';
        var cell = document.createElement('div');
        cell.className = 'bp-cell bp-cell-confirmed zone-' + zone + (isNew ? ' bp-cell-new' : '');
        /* Block at confs == 9 (one below unlock threshold) gets the breathing margin. */
        if (confs === 9) cell.classList.add('bp-pre-unlock-gap');
        cell.setAttribute('data-height', b.height);
        cell.dataset.zone = zone;

        var weightKb = b.block_weight ? (b.block_weight / 1024).toFixed(1) + ' KB' : '—';
        var rewardXmr = b.reward != null ? (Number(b.reward) / 1e12).toFixed(2) + ' XMR' : '—';
        var fillH = fillHeightForTxCount(b.tx_count);

        cell.innerHTML =
            '<div class="bp-height-above">#' + Number(b.height).toLocaleString() + '</div>' +
            '<div class="bp-confs-label" data-confs="' + confs + '">' +
                confs + ' <span>conf' + (confs === 1 ? '' : 's') + '</span>' +
            '</div>' +
            '<div class="bp-block is-confirmed" role="button" tabindex="0">' +
              '<div class="bp-fill-area"><div class="bp-fill-bar" style="height:' + fillH + '%"></div></div>' +
              '<div class="bp-content">' +
                '<div class="bp-tx-count-big">' + (b.tx_count || 0).toLocaleString() + ' <span>txs</span></div>' +
                '<div class="bp-secondary-line bp-size">' + weightKb + '</div>' +
                '<div class="bp-secondary-line bp-reward">' + rewardXmr + '</div>' +
                '<div class="bp-age">' + fmtAgo(b.timestamp) + '</div>' +
              '</div>' +
            '</div>';

        var self = this;
        cell.querySelector('.bp-block').addEventListener('click', function (e) {
            /* If a drag-pan just ended, suppress this click — the user was
               panning, not selecting a block. */
            if (self._wasJustDragged && self._wasJustDragged()) {
                e.stopPropagation();
                return;
            }
            /* Prevent bubble to wrap's drag handlers, which can otherwise
               re-trigger pan logic on simulated mouse events from touch. */
            e.stopPropagation();
            if (window._xmrDebug) {
                console.log('[parade.blockClick]', { height: b.height });
            }
            if (self.onBlockClick) self.onBlockClick(String(b.height));
        });
        return cell;
    };

    /* Update a persistent confirmed-cell node in place. Compare-then-set
       to avoid redundant DOM mutations on the steady-state refresh. */
    BlockParade.prototype._updateConfirmedBlock = function (cellNode, b, indexInBlocks) {
        /* Confs from height math — robust to gaps in this.blocks. */
        var newConfs = Math.max(1, this.topHeight - Number(b.height) + 1);
        var nextZone = newConfs >= 10 ? 'unlocked' : 'confirming';
        if (cellNode.dataset.zone !== nextZone) {
            cellNode.classList.remove('zone-confirming', 'zone-unlocked');
            cellNode.classList.add('zone-' + nextZone);
            cellNode.dataset.zone = nextZone;
        }
        /* The 9-conf block (one below unlock threshold) gets the breathing-room
           margin. The same DOM node may shift between confs across renders, so
           toggle every time. */
        cellNode.classList.toggle('bp-pre-unlock-gap', newConfs === 9);
        var confsLabel = cellNode.querySelector('.bp-confs-label');
        if (confsLabel && Number(confsLabel.dataset.confs) !== newConfs) {
            confsLabel.dataset.confs = String(newConfs);
            confsLabel.innerHTML = newConfs + ' <span>conf' + (newConfs === 1 ? '' : 's') + '</span>';
        }
        var fill = cellNode.querySelector('.bp-fill-bar');
        if (fill) {
            var newH = fillHeightForTxCount(b.tx_count) + '%';
            if (fill.style.height !== newH) fill.style.height = newH;
        }
        var age = cellNode.querySelector('.bp-age');
        if (age) {
            var newAge = fmtAgo(b.timestamp);
            if (age.textContent !== newAge) age.textContent = newAge;
        }
    };

    BlockParade.prototype._makePendingBlock = function (opts) {
        var cell = document.createElement('div');
        var fillH = opts.txCount != null ? fillHeightForTxCount(opts.txCount) : 30;
        var sizeStr = opts.weight != null ? (opts.weight / 1024).toFixed(1) + ' KB' : '—';

        cell.innerHTML =
            '<div class="bp-height-above">~#' + Number(opts.height).toLocaleString() + '</div>' +
            '<div class="bp-block is-pending' + (opts.isNext ? ' is-pending-next' : ' is-far') + '">' +
              '<div class="bp-fill-area"><div class="bp-fill-bar" style="height:' + fillH + '%"></div></div>' +
              '<div class="bp-content">' +
                '<div class="bp-pending-marker">' + (opts.isNext ? '⟳ NEXT' : '⟳ QUEUED') + '</div>' +
                '<div class="bp-tx-count-big">' + (opts.txCount != null ? Number(opts.txCount).toLocaleString() : '—') + ' <span>txs</span></div>' +
                '<div class="bp-secondary-line bp-size">' + sizeStr + '</div>' +
                '<div class="bp-age">' + (opts.eta || '') + '</div>' +
              '</div>' +
            '</div>';

        cell.className = 'bp-cell bp-cell-pending zone-pending' + (opts.isNext ? ' is-next-bright' : ' is-far');
        cell.dataset.zone = 'pending';
        cell.setAttribute('data-height', opts.height);

        // Make pending blocks clickable → fires onBlockClick with 'pending'
        var self = this;
        cell.querySelector('.bp-block').addEventListener('click', function (e) {
            e.stopPropagation();
            if (self._wasJustDragged && self._wasJustDragged()) return;
            if (self.onBlockClick) self.onBlockClick('pending');
        });

        return cell;
    };

    /* Public entry point: coalesces multiple render() calls within a single
       animation frame into one actual render. Prevents thrash when refresh +
       setTracked + scroll all fire within ~16ms of each other. */
    BlockParade.prototype.render = function () {
        if (this._renderQueued) return;
        this._renderQueued = true;
        var self = this;
        requestAnimationFrame(function () {
            self._renderQueued = false;
            self._renderImpl();
        });
    };

    BlockParade.prototype._renderImpl = function () {
        var self = this;

        var digest = '';
        var bs = this.blocks || [];
        digest += bs.length + ':';
        digest += (bs[0] ? bs[0].height : 0) + ':';
        for (var di = 0; di < bs.length; di++) {
            digest += (bs[di].height || 0) + ',' + (bs[di].tx_count || 0) + ';';
        }
        digest += '|tracked=' + (this.trackedTxid || '') + ':' + (this.trackedBlock || '');
        digest += '|hl=' + (this._highlightedBlock || '');
        digest += '|status=' + (this.trackedStatus || '');

        var fullRenderNeeded = (digest !== this._renderDigest);
        this._renderDigest = digest;

        if (!fullRenderNeeded) {
            if (this._confirmedNodes) {
                this.blocks.forEach(function (b) {
                    var n = self._confirmedNodes[b.height];
                    if (!n) return;
                    var ageEl = n.querySelector('.bp-age');
                    if (ageEl) {
                        var na = fmtAgo(b.timestamp);
                        if (ageEl.textContent !== na) ageEl.textContent = na;
                    }
                });
            }
            return;
        }

        this._renderStatusBar();

        /* FLIP step 1 (First): record current bounding rects of all confirmed blocks.

           CRITICAL — Settle any in-flight Play transforms BEFORE measuring. If a
           previous render's .Play transition is still running (the user can trigger
           a re-render by scrolling, hovering, or via the 15s refresh interval
           landing during a previous transition), getBoundingClientRect() returns
           a transformed position that's a lie — somewhere between old and new
           layout. Computing dx against that lie produces visibly chaotic motion.

           Solution: clear all transforms instantly (transition:none + transform:'')
           before capturing firstRects. This snaps any in-flight blocks to their
           true layout positions, so we measure truth. */
        var firstRects = Object.create(null);
        if (this._confirmedNodes) {
            /* 1a. Settle. */
            Object.keys(this._confirmedNodes).forEach(function (h) {
                var node = self._confirmedNodes[h];
                if (node && node.isConnected) {
                    node.style.transition = 'none';
                    node.style.transform = '';
                }
            });
            /* 1b. Force a synchronous reflow so the cleared transform takes effect
                   before getBoundingClientRect runs. Without this the browser may
                   batch the style mutation with subsequent reads. */
            void this.container.offsetWidth;
            /* 1c. NOW capture truthful layout positions. */
            Object.keys(this._confirmedNodes).forEach(function (h) {
                var node = self._confirmedNodes[h];
                if (node && node.isConnected) {
                    firstRects[h] = node.getBoundingClientRect();
                }
            });
        }

        var pendingGroup   = this.container.querySelector('.bp-pending-group');
        var confirmedGroup = this.container.querySelector('.bp-confirmed-group');
        if (!pendingGroup || !confirmedGroup) return;

        var tip = this.blocks.length ? this.blocks[0].height : this.topHeight;

        /* ── Pending group ───────────────────────────────────────── */
        var mp = this.pending || {};
        var recent = Array.isArray(mp.recent_txs) ? mp.recent_txs : [];
        var avgRate = 0;
        if (recent.length) {
            var sum = 0, n = 0;
            for (var i = 0; i < recent.length; i++) {
                var r = Number(recent[i].fee_rate);
                if (r > 0) { sum += r; n++; }
            }
            avgRate = n > 0 ? sum / n : 0;
        }
        var nextTier = avgRate > 0 ? feeTier(avgRate) : 'med';   /* fallback gold */
        var farTier  = 'low';                                     /* dim green */

        var projFill = mp.projected_block && mp.projected_block.fill_pct != null
            ? mp.projected_block.fill_pct : 0;
        var pendTxs  = mp.tx_count != null ? mp.tx_count : null;

        var pendingFrag = document.createDocumentFragment();
        /* Far-future block first (FAR LEFT), then next-to-mine adjacent to divider. */
        pendingFrag.appendChild(this._makePendingBlock({
            height:  tip ? tip + 2 : '—',
            isNext:  false,
            tier:    farTier,
            fillPct: 0,
            txCount: null,
            label:   '⟳ QUEUED',
            eta:     'In ~4 min'
        }));
        pendingFrag.appendChild(this._makePendingBlock({
            height:  tip ? tip + 1 : '—',
            isNext:  true,
            tier:    nextTier,
            fillPct: projFill,
            txCount: pendTxs,
            label:   '⟳ NEXT',
            eta:     'In ~2 min'
        }));
        pendingGroup.replaceChildren(pendingFrag);

        /* ── Confirmed group: true keyed DOM diff ───────────────── */
        var wanted = Object.create(null);
        this.blocks.forEach(function (b) { wanted[b.height] = true; });

        if (!this._confirmedNodes) this._confirmedNodes = Object.create(null);

        /* Remove nodes no longer wanted */
        Object.keys(this._confirmedNodes).forEach(function (h) {
            if (!wanted[h]) {
                self._confirmedNodes[h].remove();
                delete self._confirmedNodes[h];
            }
        });

        /* Create-or-update each wanted block, ensure correct position.
           blocks is newest-first → index 0 is the DOM's first child
           (adjacent to the divider on the confirmed side). */
        this.blocks.forEach(function (b, idx) {
            var node = self._confirmedNodes[b.height];
            if (!node) {
                node = self._makeConfirmedBlock(b, true, idx);
                self._confirmedNodes[b.height] = node;
            } else {
                self._updateConfirmedBlock(node, b, idx);
            }
            var currentAtIdx = confirmedGroup.children[idx];
            if (currentAtIdx !== node) {
                confirmedGroup.insertBefore(node, currentAtIdx || null);
            }
        });

        /* FLIP step 2 (Last → Invert → Play). Critical ordering:
           1. Call _positionOverlays() FIRST — while transforms are still
              identity, getBoundingClientRect returns post-keyed-diff LAYOUT
              positions (the correct new anchor positions for arrow/dotline).
           2. THEN apply Invert (set transform on each shifted block to its
              old visual position).
           3. THEN force a synchronous reflow.
           4. THEN in the next animation frame, Play (transition transform
              back to identity).

           If we reverse 1 and 2, _positionOverlays sees TRANSFORMED (= old)
           positions. The dotline ends up positioned at the old anchor — which
           combined with its own transition causes the visible "line moves
           left by ~134px" bug the user reported. */
        requestAnimationFrame(function () {
            /* 1. Position overlays based on post-layout positions (transforms
                  not yet applied). */
            self._positionOverlays();

            /* 2. Invert: snap each existing block to its old visual position. */
            var moving = [];
            Object.keys(self._confirmedNodes).forEach(function (h) {
                var node = self._confirmedNodes[h];
                var first = firstRects[h];
                if (!first || !node.isConnected) return;

                var last = node.getBoundingClientRect();
                var dx = first.left - last.left;
                if (Math.abs(dx) < 1) return;   /* didn't actually move */

                node.style.transition = 'none';
                node.style.transform = 'translate3d(' + dx + 'px, 0, 0)';
                moving.push(node);
            });

            /* 3. Force a synchronous reflow so the browser commits the
                  transition:none + transform:Xpx state before we change it
                  again. Without this, the browser may batch the two
                  transition mutations together and the Invert step animates
                  silently. */
            if (moving.length) void self.container.offsetWidth;

            if (window._xmrDebug && moving.length) {
                console.log('[parade.flip] moving', moving.length, 'blocks');
            }

            /* 4. Play: in the next animation frame, transition each moving
                  block back to identity. */
            requestAnimationFrame(function () {
                for (var i = 0; i < moving.length; i++) {
                    moving[i].style.transition = 'transform 1.4s cubic-bezier(.45,.85,.35,1)';
                    moving[i].style.transform = 'translate3d(0, 0, 0)';
                }
            });
        });
    };

    BlockParade.prototype._positionOverlays = function () {
        var self = this;
        var outer   = this.container.querySelector('.bp-outer');
        var overlay = this.container.querySelector('.bp-overlay');
        if (!outer || !overlay) return;
        var arrow   = overlay.querySelector('.bp-arrow');
        var dotline = overlay.querySelector('.bp-dotline');
        var hint    = overlay.querySelector('.bp-offscreen-hint');
        if (!arrow || !dotline) return;

        var outerRect      = outer.getBoundingClientRect();
        var confirmedGroup = this.container.querySelector('.bp-confirmed-group');

        /* Arrow priority: pending > tracked-block > highlight > none */
        var target   = null;   /* height the arrow wants to point at (if any) */
        var targetEl = null;
        var mode     = null;   /* 'pending' | 'confirming' | 'confirmed' | 'highlight' */

        if (this.trackedStatus === 'pending') {
            targetEl = this.container.querySelector('.bp-block.is-pending.is-next-bright');
            mode = 'pending';
        } else if (this.trackedBlock) {
            target   = this.trackedBlock;
            targetEl = this.container.querySelector('.bp-cell[data-height="' + this.trackedBlock + '"] .bp-block');
            mode     = this.trackedConfs >= CONF_REQ ? 'confirmed' : 'confirming';
        } else if (this._highlightedBlock) {
            target   = this._highlightedBlock;
            targetEl = this.container.querySelector('.bp-cell[data-height="' + this._highlightedBlock + '"] .bp-block');
            mode     = 'highlight';
        }

        arrow.classList.remove('is-pending', 'is-confirming', 'is-confirmed', 'is-highlight');
        if (!mode) {
            /* No tracking active at all — hide the arrow. */
            arrow.hidden = true;
            self._lastArrowState = null;
        } else if (!targetEl) {
            /* Tracking IS active but the cell isn't queryable this tick — could
               be a transient race (cell was just re-keyed) or the tracked block
               genuinely fell off MAX_CONFIRMED. The off-range branch below will
               handle the latter case explicitly. For the transient race, KEEP the
               arrow visible at its last known position so it doesn't flicker. */
            if (self._lastArrowState) {
                arrow.hidden = false;
                arrow.classList.add('is-' + self._lastArrowState.mode);
                arrow.style.transform = self._lastArrowState.transform;
                var prevLabel = arrow.querySelector('.bp-arrow-label');
                if (prevLabel) prevLabel.textContent = self._lastArrowState.label;
            } else {
                arrow.hidden = true;
            }
        } else {
            arrow.hidden = false;
            arrow.classList.add('is-' + mode);
            var r = targetEl.getBoundingClientRect();
            var ax = (r.left + r.width / 2 - outerRect.left);
            var ay = (r.bottom - outerRect.top + 2);
            var transformStr = 'translate3d(' + ax + 'px, ' + ay + 'px, 0) translateX(-50%)';
            arrow.style.transform = transformStr;

            var label = arrow.querySelector('.bp-arrow-label');
            var labelText = '';
            if (label) {
                if      (mode === 'pending')    labelText = '⟳ UNCONF';
                else if (mode === 'confirmed')  labelText = '✓ 10/10';
                else if (mode === 'confirming') labelText = this.trackedConfs + '/10';
                else if (mode === 'highlight')  labelText = '#' + Number(this._highlightedBlock).toLocaleString();
                label.textContent = labelText;
            }

            /* Cache for next tick's persistence guard. */
            self._lastArrowState = { mode: mode, transform: transformStr, label: labelText };
        }

        /* 10-conf line: anchor to the actual block where confs first reaches 10.
           Height-based, NOT slot-based — the line sits at protocol meaning,
           not at array slot. Robust to gaps in this.blocks: even if upstream
           RPCs failed to fetch some heights, the line still tracks the real
           unlock threshold by computing confs from height delta to the tip. */
        if (this.blocks && this.blocks.length && confirmedGroup) {
            var unlockBlock = null;
            for (var i = 0; i < this.blocks.length; i++) {
                var c = Math.max(1, this.topHeight - Number(this.blocks[i].height) + 1);
                if (c >= 10) {
                    unlockBlock = this.blocks[i];
                    break;
                }
            }

            if (unlockBlock) {
                var unlockEl = this.container.querySelector(
                    '.bp-cell[data-height="' + unlockBlock.height + '"] .bp-block');
                if (unlockEl) {
                    var ur = unlockEl.getBoundingClientRect();
                    /* Position the line just to the left of the unlock block,
                       in the middle of any breathing-room gap. */
                    var lineX = (ur.left - outerRect.left) - 14;
                    dotline.hidden = false;
                    dotline.style.transform = 'translate3d(' + lineX + 'px, 0, 0)';
                } else {
                    dotline.hidden = true;
                }
            } else {
                /* No block has reached 10 confs yet — hide the line. */
                dotline.hidden = true;
            }
        } else {
            dotline.hidden = true;
        }

        /* Off-range — target height known but not in visible blocks. The
           arrow itself anchors to the right edge of the confirmed group with
           a "→ N BACK" label so the user can see direction + distance at a
           glance. The chip-style hint is suppressed in this case. */
        if (hint && confirmedGroup) {
            if (target && !targetEl) {
                var tipH = this.blocks.length ? this.blocks[0].height : this.topHeight;
                var back = Math.max(0, Number(tipH) - Number(target));
                var cRect = confirmedGroup.getBoundingClientRect();

                arrow.hidden = false;
                arrow.classList.add('is-' + (mode || 'highlight'));
                var oax = (cRect.right - outerRect.left);
                var oay = (cRect.bottom - outerRect.top + 2);
                arrow.style.transform = 'translate3d(' + oax + 'px, ' + oay + 'px, 0) translateX(-50%)';
                var oLabel = arrow.querySelector('.bp-arrow-label');
                if (oLabel) oLabel.textContent = '→ ' + back + ' BACK';

                hint.hidden = true;
            } else {
                hint.hidden = true;
            }
        }
    };

    /* Center the tracked/highlighted block in the visible scroll viewport.
       Falls back through pending → tracked → highlighted in priority order. */
    BlockParade.prototype._scrollToTrackedBlock = function (opts) {
        opts = opts || {};
        var smooth = opts.smooth !== false;
        var wrap = this.container.querySelector('.bp-wrap');
        if (!wrap) return;

        var targetEl = null;
        if (this.trackedStatus === 'pending') {
            targetEl = this.container.querySelector('.bp-cell-pending.is-next-bright .bp-block');
        } else if (this.trackedBlock) {
            targetEl = this.container.querySelector('.bp-cell[data-height="' + this.trackedBlock + '"] .bp-block');
        } else if (this._highlightedBlock) {
            targetEl = this.container.querySelector('.bp-cell[data-height="' + this._highlightedBlock + '"] .bp-block');
        }
        if (!targetEl) return;

        var wrapRect   = wrap.getBoundingClientRect();
        var targetRect = targetEl.getBoundingClientRect();
        var targetCenter = targetRect.left + targetRect.width / 2 - wrapRect.left + wrap.scrollLeft;
        var newScroll    = Math.max(0, targetCenter - wrap.clientWidth / 2);

        if (smooth) {
            wrap.scrollTo({ left: newScroll, behavior: 'smooth' });
        } else {
            wrap.scrollLeft = newScroll;
        }
    };

    global.BlockParade = BlockParade;
})(window);
