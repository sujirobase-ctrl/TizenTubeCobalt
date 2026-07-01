// ZeroDelay for TizenTube Cobalt
// Adapted from ZeroDelay by João Gustavo França (https://github.com/joaogfc/ZeroDelay)
// Reduces live stream latency by speeding up playback to catch up with the live edge.
// Licensed under GPL-3.0

(() => {
    'use strict';

    const STORAGE_KEY = 'zerodelay_enabled';
    const STORAGE_MODE_KEY = 'zerodelay_mode';

    function isEnabled() {
        const val = localStorage.getItem(STORAGE_KEY);
        return val === null ? true : val === 'true';
    }

    function getMode() {
        return localStorage.getItem(STORAGE_MODE_KEY) || 'auto';
    }

    function setEnabled(val) {
        localStorage.setItem(STORAGE_KEY, val ? 'true' : 'false');
    }

    // --- Mode presets ---
    const PRESETS = {
        auto:       { playbackRate: 1.25, auto: true,  bufferTarget: 6.0, skip: true, skipThreshold: 30.0 },
        suave:      { playbackRate: 1.25, auto: false, bufferTarget: 8.0, skip: true, skipThreshold: 30.0 },
        balanced:   { playbackRate: 1.25, auto: false, bufferTarget: 6.0, skip: true, skipThreshold: 30.0 },
        aggressive: { playbackRate: 1.25, auto: false, bufferTarget: 4.5, skip: true, skipThreshold: 30.0 },
        min:        { playbackRate: 1.25, auto: false, bufferTarget: 3.5, skip: true, skipThreshold: 30.0 },
    };

    function getPreset() {
        return PRESETS[getMode()] || PRESETS.auto;
    }

    // --- Playback-rate controller ---
    let applied_rate = 1.0;
    let yielded_to_user = false;

    function apply_playback_rate(player, desired) {
        if (!player?.setPlaybackRate) return;
        const cur = player.getPlaybackRate();
        if (Math.abs(cur - applied_rate) > 0.01) {
            if (Math.abs(cur - 1.0) < 0.01) {
                applied_rate = 1.0;
                yielded_to_user = false;
            } else {
                yielded_to_user = true;
                applied_rate = cur;
            }
        }
        if (yielded_to_user) return;
        if (Math.abs(desired - applied_rate) > 0.01) {
            player.setPlaybackRate(desired);
            applied_rate = desired;
        }
    }

    function reset_playbackRate(player) {
        if (applied_rate !== 1.0 && !yielded_to_user) {
            apply_playback_rate(player, 1.0);
        }
    }

    // --- Buffer-aware catch-up ---
    const BUFFER_FLOOR = 1.5;
    const BUFFER_BACKOFF = 2.5;
    const BUFFER_RESUME = 4.0;
    const CATCH_UP_BAND = 1.5;
    const MIN_LATENCY = 2.0;
    let buffer_headroom_ok = true;
    let buffer_ema = null;
    let catching_up = false;

    function accel_allowed_by_buffer(health) {
        if (!isFinite(health)) return false;
        if (health <= BUFFER_BACKOFF) buffer_headroom_ok = false;
        else if (health >= BUFFER_RESUME) buffer_headroom_ok = true;
        return buffer_headroom_ok;
    }

    // Automatic mode: adapt the buffer target to the connection.
    let auto_target = 6.0;
    let auto_cooldown = 0;
    function auto_buffer_target(health) {
        if (isFinite(health) && health < 1.0) {
            auto_target = Math.min(9.0, auto_target + 1.0);
            auto_cooldown = 240;
        } else if (auto_cooldown > 0) {
            auto_cooldown--;
        } else if (buffer_ema !== null && buffer_ema > auto_target + 2.0) {
            auto_target = Math.max(4.0, auto_target - 0.01);
        }
        return auto_target;
    }

    function calc_playbackRate(speed, latency, health, bufferTarget, isAuto) {
        if (!isFinite(health) || !isFinite(latency)) return 1.0;
        buffer_ema = buffer_ema === null ? health : buffer_ema * 0.9 + health * 0.1;
        if (latency < MIN_LATENCY) return 1.0;

        const target = isAuto ? auto_buffer_target(health) : bufferTarget;
        if (buffer_ema > target + CATCH_UP_BAND) catching_up = true;
        else if (buffer_ema <= target) catching_up = false;
        if (!catching_up) return 1.0;

        if (health < BUFFER_FLOOR || !accel_allowed_by_buffer(health)) return 1.0;
        return speed;
    }

    function skip_if_over_threshold(player, latency, skipThreshold) {
        if (player && latency >= skipThreshold) {
            if (player.getPlayerStateObject && player.getPlayerStateObject()?.isPlaying) {
                player.seekToLiveHead();
                player.playVideo();
            }
        }
    }

    // --- Status indicator ---
    let statusEl = null;

    function createStatusIndicator() {
        if (statusEl) return;
        statusEl = document.createElement('div');
        statusEl.id = 'zerodelay-status';
        statusEl.style.cssText = [
            'position:fixed', 'top:10px', 'right:10px', 'z-index:999999',
            'padding:6px 12px', 'border-radius:6px',
            'background:rgba(0,0,0,0.7)', 'color:#fff',
            'font:bold 13px/1.4 sans-serif',
            'pointer-events:none', 'transition:opacity 0.3s',
        ].join(';');
        document.body.appendChild(statusEl);
    }

    function updateStatus(enabled, latency, health, currentRate) {
        if (!statusEl) return;
        if (!enabled) {
            statusEl.style.opacity = '0';
            return;
        }
        statusEl.style.opacity = '1';
        const rateStr = currentRate > 1.01 ? ` | ${currentRate.toFixed(2)}x` : '';
        const latStr = isFinite(latency) ? `${latency.toFixed(1)}s` : '--';
        const healthStr = isFinite(health) ? `${health.toFixed(1)}s` : '--';
        statusEl.textContent = `ZD: ${latStr}${rateStr} | buf: ${healthStr}`;
        statusEl.style.color = health < BUFFER_BACKOFF ? '#ff8983' : '#4ffa7a';
    }

    // --- Main loop ---
    let mainInterval = null;
    let player = null;

    function startEngine() {
        if (mainInterval) return;
        mainInterval = setInterval(() => {
            if (!player) {
                player = document.getElementById('movie_player');
                if (!player) return;
            }

            const enabled = isEnabled();
            if (!player.getStatsForNerds) {
                if (statusEl) statusEl.style.opacity = '0';
                return;
            }

            const stats = player.getStatsForNerds();
            if (!stats || stats.live_latency_style !== '') {
                if (statusEl) statusEl.style.opacity = '0';
                return;
            }

            const latency = Number.parseFloat(stats.live_latency_secs);
            const health = Number.parseFloat(stats.buffer_health_seconds);
            const preset = getPreset();

            if (enabled) {
                const desired = calc_playbackRate(
                    preset.playbackRate, latency, health,
                    preset.bufferTarget, preset.auto
                );
                apply_playback_rate(player, desired);

                if (preset.skip) {
                    skip_if_over_threshold(player, latency, preset.skipThreshold);
                }
            } else {
                reset_playbackRate(player);
            }

            const video = player.querySelector('video.html5-main-video');
            const currentRate = video ? video.playbackRate : 1.0;
            updateStatus(enabled, latency, health, currentRate);
        }, 250);
    }

    // --- Initialization ---
    function init() {
        createStatusIndicator();
        startEngine();

        // Expose global API for TizenTube settings integration
        window.ZeroDelay = {
            isEnabled: isEnabled,
            setEnabled: (val) => {
                setEnabled(val);
                if (!val && player) reset_playbackRate(player);
                updateStatus(val, NaN, NaN, 1.0);
            },
            getMode: getMode,
            setMode: (mode) => {
                if (PRESETS[mode]) {
                    localStorage.setItem(STORAGE_MODE_KEY, mode);
                }
            },
            getModes: () => Object.keys(PRESETS),
            toggle: () => {
                const newVal = !isEnabled();
                window.ZeroDelay.setEnabled(newVal);
                return newVal;
            },
        };
    }

    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
