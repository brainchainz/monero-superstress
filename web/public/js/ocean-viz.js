/* OceanViz — Canvas 2D particle ocean, one bubble per mempool tx.
   5-tier colors by fee_rate (piconero/byte). Radius by blob_size (log).
   Entrance animation on add, dissolve on remove/confirmation.
   Hover → tooltip; click → navigate to ?tx=TXID.
   Cap: 500 bubbles; evict oldest by receive_time when exceeded. */
(function (global) {
    'use strict';
    var MO = global.MempoolOceanShared || (global.MempoolOceanShared = {});
    var MAX_BUBBLES = 500;

    function OceanViz(canvas, opts) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.reduced = !!(opts && opts.reducedMotion);
        this.tooltipEl = opts && opts.tooltipEl;
        this.onClickTx = (opts && opts.onClickTx) || null;

        this.particles = new Map();       // txid → particle
        this.raf = 0;
        this.running = false;
        this.hover = null;                 // hovered txid
        this.mouse = { x: -1, y: -1, inside: false };

        this._resize();
        var self = this;
        this._ro = ('ResizeObserver' in global) ? new ResizeObserver(function () { self._resize(); }) : null;
        if (this._ro) this._ro.observe(canvas);
        else global.addEventListener('resize', function () { self._resize(); });

        canvas.addEventListener('mousemove', function (e) {
            var r = canvas.getBoundingClientRect();
            self.mouse.x = e.clientX - r.left;
            self.mouse.y = e.clientY - r.top;
            self.mouse.inside = true;
            self._updateHover();
        });
        canvas.addEventListener('mouseleave', function () {
            self.mouse.inside = false;
            self._hideTooltip();
        });
        canvas.addEventListener('click', function () {
            if (self.hover && self.onClickTx) self.onClickTx(self.hover);
        });
    }

    OceanViz.prototype._resize = function () {
        var dpr = Math.min(global.devicePixelRatio || 1, 2);
        var c = this.canvas;
        var w = c.clientWidth || 800;
        var h = c.clientHeight || 320;
        c.width = w * dpr;
        c.height = h * dpr;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.w = w;
        this.h = h;
    };

    OceanViz.prototype.start = function () {
        if (this.running) return;
        this.running = true;
        if (this.reduced) { this._drawFrame(); return; }
        var self = this;
        var loop = function () {
            if (!self.running) return;
            self._drawFrame();
            self.raf = global.requestAnimationFrame(loop);
        };
        this.raf = global.requestAnimationFrame(loop);
    };

    OceanViz.prototype.stop = function () {
        this.running = false;
        if (this.raf) { global.cancelAnimationFrame(this.raf); this.raf = 0; }
    };

    OceanViz.prototype._radius = function (blobSize) {
        return Math.max(4, Math.min(22, Math.log((blobSize || 1000) + 1) * 2.2));
    };

    OceanViz.prototype._makeParticle = function (tx) {
        var cls = window.XmrRelayWS.tierByKey(tx.fee_tier) || window.XmrRelayWS.classify(tx.fee_rate);
        var r = this._radius(tx.blob_size);
        // Spawn at a random edge, drift inward.
        var edge = Math.floor(Math.random() * 4);
        var x, y, vx, vy, pad = r + 4;
        if (edge === 0)      { x = Math.random() * this.w; y = -pad;        vx = (Math.random() - 0.5) * 0.2; vy = 0.25 + Math.random() * 0.2; }
        else if (edge === 1) { x = this.w + pad;           y = Math.random() * this.h; vx = -(0.25 + Math.random() * 0.2); vy = (Math.random() - 0.5) * 0.2; }
        else if (edge === 2) { x = Math.random() * this.w; y = this.h + pad; vx = (Math.random() - 0.5) * 0.2; vy = -(0.25 + Math.random() * 0.2); }
        else                 { x = -pad;                   y = Math.random() * this.h; vx = 0.25 + Math.random() * 0.2; vy = (Math.random() - 0.5) * 0.2; }
        return {
            txid: tx.txid,
            blob_size: tx.blob_size,
            fee: tx.fee,
            fee_rate: tx.fee_rate,
            receive_time: tx.receive_time,
            color: cls.color,
            tierLabel: cls.label,
            r: r,
            x: x, y: y, vx: vx, vy: vy,
            birth: performance.now(),
            dying: 0  // >0 = dissolve progress ms
        };
    };

    // Merge incoming tx list into particle pool.
    OceanViz.prototype.sync = function (txs) {
        if (!Array.isArray(txs)) return;
        var incoming = Object.create(null);
        for (var i = 0; i < txs.length; i++) incoming[txs[i].txid] = txs[i];

        // Add new
        for (var txid in incoming) {
            if (!this.particles.has(txid)) this.particles.set(txid, this._makeParticle(incoming[txid]));
        }

        // Mark departed (not in incoming) as dying
        var toDie = [];
        this.particles.forEach(function (p, id) {
            if (!incoming[id] && !p.dying) toDie.push(p);
        });
        for (var j = 0; j < toDie.length; j++) toDie[j].dying = 1;

        // Cap by evicting oldest (receive_time ascending) when over limit
        if (this.particles.size > MAX_BUBBLES) {
            var all = Array.from(this.particles.values()).sort(function (a, b) {
                return (a.receive_time || 0) - (b.receive_time || 0);
            });
            var over = this.particles.size - MAX_BUBBLES;
            for (var k = 0; k < over; k++) this.particles.delete(all[k].txid);
        }
    };

    OceanViz.prototype.confirmTxids = function (txids) {
        if (!Array.isArray(txids)) return;
        for (var i = 0; i < txids.length; i++) {
            var p = this.particles.get(txids[i]);
            if (p && !p.dying) p.dying = 1;
        }
    };

    OceanViz.prototype._stepPhysics = function () {
        var particles = this.particles;
        var w = this.w, h = this.h;
        particles.forEach(function (p, id) {
            if (p.dying) {
                p.dying += 16;
                if (p.dying > 600) particles.delete(id);
            }
            // Gentle drift
            p.x += p.vx;
            p.y += p.vy;
            // Mild Brownian jitter
            p.vx += (Math.random() - 0.5) * 0.04;
            p.vy += (Math.random() - 0.5) * 0.04;
            // Damping
            p.vx *= 0.985;
            p.vy *= 0.985;
            // Soft boundary: bounce on walls
            if (p.x < p.r) { p.x = p.r; p.vx = Math.abs(p.vx); }
            if (p.x > w - p.r) { p.x = w - p.r; p.vx = -Math.abs(p.vx); }
            if (p.y < p.r) { p.y = p.r; p.vy = Math.abs(p.vy); }
            if (p.y > h - p.r) { p.y = h - p.r; p.vy = -Math.abs(p.vy); }
        });
    };

    OceanViz.prototype._drawFrame = function () {
        if (!this.reduced) this._stepPhysics();
        var ctx = this.ctx, w = this.w, h = this.h;
        ctx.clearRect(0, 0, w, h);

        // Legend
        var tiers = window.XmrRelayWS.FEE_TIERS;
        ctx.font = '9px "DM Mono", monospace';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        var lx = 10, ly = 14;
        for (var i = 0; i < tiers.length; i++) {
            ctx.fillStyle = tiers[i].color;
            ctx.beginPath(); ctx.arc(lx, ly, 3.5, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = 'rgba(255,255,255,0.6)';
            ctx.fillText(tiers[i].label, lx + 7, ly);
            lx += ctx.measureText(tiers[i].label).width + 24;
        }

        // Particles
        var now = performance.now();
        this.particles.forEach(function (p) {
            var age = now - p.birth;
            var scale = Math.min(1, age / 400);            // entrance
            var alpha = 1;
            if (p.dying) {
                var prog = Math.min(1, p.dying / 600);
                alpha = 1 - prog;
                scale = 1 + prog * 0.6;
            }
            ctx.globalAlpha = alpha;
            ctx.fillStyle = p.color;
            ctx.beginPath(); ctx.arc(p.x, p.y, p.r * scale, 0, Math.PI * 2); ctx.fill();
            ctx.globalAlpha = 1;
        });

        // Hover ring
        if (this.hover) {
            var hp = this.particles.get(this.hover);
            if (hp) {
                ctx.strokeStyle = 'rgba(255,255,255,0.9)';
                ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.arc(hp.x, hp.y, hp.r + 3, 0, Math.PI * 2); ctx.stroke();
            }
        }
    };

    OceanViz.prototype._updateHover = function () {
        if (!this.mouse.inside) { this.hover = null; this._hideTooltip(); return; }
        var mx = this.mouse.x, my = this.mouse.y, found = null, foundP = null;
        this.particles.forEach(function (p) {
            if (p.dying) return;
            var dx = p.x - mx, dy = p.y - my;
            if (dx * dx + dy * dy < (p.r + 2) * (p.r + 2)) { found = p.txid; foundP = p; }
        });
        this.hover = found;
        if (foundP) this._showTooltip(foundP); else this._hideTooltip();
    };

    OceanViz.prototype._showTooltip = function (p) {
        if (!this.tooltipEl) return;
        var fmt = MO.fmt;
        var age = Math.max(0, Date.now() - (p.receive_time || 0) * 1000);
        this.tooltipEl.innerHTML =
            '<div class="mp-tt-row"><span>txid</span><b>' + fmt.txidShort(p.txid) + '</b></div>' +
            '<div class="mp-tt-row"><span>size</span><b>' + fmt.bytes(p.blob_size) + '</b></div>' +
            '<div class="mp-tt-row"><span>fee</span><b>' + fmt.xmr(p.fee) + ' XMR</b></div>' +
            '<div class="mp-tt-row"><span>rate</span><b>' + (p.fee_rate || 0).toFixed(1) + ' p/B</b></div>' +
            '<div class="mp-tt-row"><span>age</span><b>' + fmt.age(age) + '</b></div>' +
            '<div class="mp-tt-tier" style="color:' + p.color + '">' + p.tierLabel + '</div>';
        this.tooltipEl.hidden = false;
        var tx = Math.min(this.w - 180, this.mouse.x + 14);
        var ty = Math.min(this.h - 110, this.mouse.y + 14);
        this.tooltipEl.style.transform = 'translate(' + tx + 'px,' + ty + 'px)';
        this.canvas.style.cursor = 'pointer';
    };

    OceanViz.prototype._hideTooltip = function () {
        if (this.tooltipEl) this.tooltipEl.hidden = true;
        this.canvas.style.cursor = 'default';
    };

    OceanViz.prototype.destroy = function () {
        this.stop();
        if (this._ro) { try { this._ro.disconnect(); } catch (_) {} this._ro = null; }
        this.particles.clear();
    };

    MO.OceanViz = OceanViz;
})(window);
