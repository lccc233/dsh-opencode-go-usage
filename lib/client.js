/**
 * OpenCode Go usage monitor — browser half.
 *
 * Renders a compact threshold-coloured ring in the Composer dock, immediately
 * to the RIGHT of the context meter (the dock row is a centred flex row, so the
 * root carries `order: 1`). Hovering, focusing or clicking the ring opens a
 * portal panel with one progress bar and its description per quota window
 * (5h rolling / weekly / monthly), the reset countdown, the sample's age and a
 * manual refresh.
 *
 * Data comes from the host half's snapshot route on this origin; the API key
 * never reaches the browser.
 *
 * This bundle is lazy-CommonJS: one factory registered with the module loader
 * at boot, and every module side effect runs when the factory materializes.
 */
window.__ModuleLoader__.load({
  // This id MUST equal package.json's `name`. The shell keys the boot graph by
  // package name; a mismatch leaves the row looking unregistered, so the shell
  // fetches this bundle again, and the duplicate registration is fatal to the
  // whole web boot ("web boot: 1 entry did not activate").
  id: 'dsh-opencode-go-usage',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const ReactDOM = require('react-dom');
    const { useCallback, useEffect, useRef, useState } = React;

    /** Snapshot route registered by the host half. */
    const SNAPSHOT_ROUTE = '/opencode-go-usage/snapshot';
    /** Quota windows in display order. */
    const WINDOWS = ['rolling', 'weekly', 'monthly'];
    /** Auto-refresh interval in milliseconds (the host caches on the same cycle). */
    const REFRESH_MS = 60_000;
    /** Delay before a hover-out closes the panel, so the pointer can reach it. */
    const CLOSE_DELAY_MS = 180;
    /** Panel width bounds, matching the context meter's panel. */
    const PANEL_WIDTH = 288;
    /** Margin kept between the panel and the viewport edges. */
    const VIEWPORT_MARGIN = 12;

    /** Simplified Chinese copy. */
    const zh = {
      title: 'OpenCode Go 套餐额度',
      rolling: '5 小时滚动',
      weekly: '本周',
      monthly: '本月',
      used: '已用 {percent}%',
      ring: '{window} · {used}（剩余 {remaining} · {reset}）',
      description: '剩余 {remaining}% · {reset}',
      resetIn: '↻{time} 后重置',
      resetPending: '等待重置时间',
      updatedJustNow: '刚刚更新',
      updatedAgo: '{time} 前更新',
      refresh: '立即刷新',
      refreshing: '刷新中…',
      loading: '正在获取额度…',
      stale: '刷新失败，显示上次数据',
      detail: '查看详情',
      unconfigured: '未配置 OpenCode Go API Key，请在设置 → 模型中填写。',
      unauthorized: 'API Key 被拒绝，请检查 OpenCode Go 凭据。',
      timeout: '请求上游超时，稍后自动重试。',
      connect: '无法连接 opencode.ai。',
      http: '上游接口返回错误。',
      parse: '上游返回了无法解析的数据。',
      'no-data': '上游没有返回任何额度窗口。',
      unknown: '额度获取失败。',
    };

    /** English copy. */
    const en = {
      title: 'OpenCode Go quota',
      rolling: '5h rolling',
      weekly: 'Weekly',
      monthly: 'Monthly',
      used: '{percent}% used',
      ring: '{window} · {used} ({remaining} left · {reset})',
      description: '{remaining}% left · {reset}',
      resetIn: 'resets in {time}',
      resetPending: 'reset time pending',
      updatedJustNow: 'updated just now',
      updatedAgo: 'updated {time} ago',
      refresh: 'Refresh now',
      refreshing: 'Refreshing…',
      loading: 'Loading quota…',
      stale: 'refresh failed, showing the last sample',
      detail: 'View details',
      unconfigured: 'No OpenCode Go API key is configured (Settings → Models).',
      unauthorized: 'The API key was rejected; check the OpenCode Go credential.',
      timeout: 'The upstream request timed out; it retries automatically.',
      connect: 'Cannot reach opencode.ai.',
      http: 'The upstream endpoint answered an error.',
      parse: 'The upstream endpoint answered an unreadable body.',
      'no-data': 'The upstream endpoint reported no quota window.',
      unknown: 'Quota lookup failed.',
    };

    /**
     * Read one dictionary entry and fill its placeholders.
     * @param language - the active language (`zh` or `en`).
     * @param key - the dictionary key.
     * @param values - placeholder values by name.
     * @returns the rendered text.
     */
    function t(language, key, values) {
      const table = language === 'zh' ? zh : en;
      const template = table[key] ?? en[key] ?? key;
      if (values === undefined) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match));
    }

    /**
     * Format a duration in milliseconds as a compact countdown.
     * @param ms - the remaining duration.
     * @returns the countdown text (`3h25m`), or null when already elapsed.
     */
    function formatDuration(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return null;
      const totalMinutes = Math.round(ms / 60_000);
      const days = Math.floor(totalMinutes / 1440);
      const hours = Math.floor((totalMinutes % 1440) / 60);
      const minutes = totalMinutes % 60;
      if (days > 0) return `${String(days)}d${hours > 0 ? `${String(hours)}h` : ''}`;
      if (hours > 0) return `${String(hours)}h${minutes > 0 ? `${String(minutes)}m` : ''}`;
      return `${String(Math.max(minutes, 1))}m`;
    }

    /**
     * Colour family for one used percentage: the shared 60/85 thresholds.
     * @param percent - used percentage, or null when unknown.
     * @returns the tone name.
     */
    function toneOf(percent) {
      if (percent === null) return 'muted';
      if (percent >= 85) return 'danger';
      if (percent >= 60) return 'warn';
      return 'ok';
    }

    /** Tone colours, expressed through the shared state aliases. */
    const TONES = {
      ok: 'var(--dsw-alias-state-success-primary, #2ea043)',
      warn: 'var(--dsw-alias-state-warning-primary, #d29922)',
      danger: 'var(--dsw-alias-state-error-primary, #f85149)',
      muted: 'var(--dsw-alias-label-tertiary, #8b949e)',
    };

    /**
     * Read one window's current figures, so the ring and the tooltip agree.
     * @param window - the snapshot's window record, when present.
     * @param now - the current timestamp.
     * @returns `{ used, remaining, countdown, resetsAt }`, with nulls where the upstream omitted a field.
     */
    function windowFigures(window, now) {
      const used = typeof window?.percent === 'number' ? Math.round(window.percent) : null;
      const resetsAt = typeof window?.resetsAt === 'string' ? Date.parse(window.resetsAt) : null;
      return {
        used,
        remaining: used === null ? null : Math.max(0, 100 - used),
        resetsAt,
        countdown: resetsAt === null ? null : formatDuration(resetsAt - now),
      };
    }

    /** Shared inline styles, mirroring the context meter's own vocabulary. */
    const styles = {
      root: {
        // The dock is a centred flex row holding [dock entries…, context meter];
        // order 1 puts this chip after the meter, i.e. to its right.
        order: 1,
        position: 'relative',
        display: 'inline-flex',
        flex: 'none',
      },
      rings: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
      ringSlot: { display: 'inline-flex', flex: 'none' },
      trigger: {
        border: 0,
        background: 'transparent',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '1px 6px',
        borderRadius: 'var(--dsw-radius-sm)',
        color: 'var(--dsw-alias-label-tertiary)',
        fontFamily: 'inherit',
        fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
        lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
        whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
      },
      triggerHover: {
        background: 'var(--dsw-alias-interactive-bg-hover)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      panel: {
        position: 'fixed',
        zIndex: 1100,
        boxSizing: 'border-box',
        padding: '12px',
        borderRadius: 'var(--dsw-radius-lg)',
        background: 'var(--dsw-specific-menu)',
        backdropFilter: 'var(--dsw-menu-backdrop-filter)',
        boxShadow: 'var(--dsw-elevation-prominent)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        lineHeight: '20px',
        maxHeight: '60vh',
        overflowY: 'auto',
      },
      panelHeader: { display: 'flex', alignItems: 'center', gap: '8px' },
      panelTitle: { color: 'var(--dsw-alias-label-primary)', fontWeight: 500 },
      panelAge: { marginLeft: 'auto', color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px' },
      row: { marginTop: '12px' },
      rowHead: { display: 'flex', alignItems: 'baseline', gap: '8px' },
      rowLabel: { color: 'var(--dsw-alias-label-secondary)' },
      rowPercent: { marginLeft: 'auto', color: 'var(--dsw-alias-label-primary)', fontWeight: 500, fontVariantNumeric: 'tabular-nums' },
      track: {
        display: 'block',
        height: '6px',
        marginTop: '4px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-interactive-bg-hover)',
        overflow: 'hidden',
      },
      trackStale: { opacity: 0.5 },
      fill: { display: 'block', height: '100%', borderRadius: '999px' },
      rowNote: { marginTop: '2px', color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px' },
      footer: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        marginTop: '12px',
        paddingTop: '10px',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: '11px',
      },
      refresh: {
        all: 'unset',
        marginLeft: 'auto',
        cursor: 'pointer',
        padding: '1px 6px',
        borderRadius: 'var(--dsw-radius-sm)',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      refreshHover: { background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-secondary)' },
      staleNote: { color: 'var(--dsw-alias-state-warning-primary, #d29922)' },
      errorText: { color: 'var(--dsw-alias-state-error-primary, #f85149)' },
    };

    /**
     * A 14px threshold ring, drawn like the context meter's own ring.
     * @param props - `percent` (0-100, or null) and `tone`.
     * @returns the ring element.
     */
    function QuotaRing({ percent, tone, size = 14 }) {
      const radius = (size - 3) / 2;
      const circumference = 2 * Math.PI * radius;
      const ratio = percent === null ? 0 : Math.max(0, Math.min(100, percent)) / 100;
      const center = size / 2;
      return React.createElement(
        'svg',
        { viewBox: `0 0 ${String(size)} ${String(size)}`, width: String(size), height: String(size), 'aria-hidden': true },
        React.createElement('circle', {
          cx: String(center),
          cy: String(center),
          r: String(radius),
          fill: 'none',
          stroke: 'var(--dsw-alias-border-l3)',
          strokeWidth: 2,
        }),
        React.createElement('circle', {
          cx: String(center),
          cy: String(center),
          r: String(radius),
          fill: 'none',
          stroke: TONES[tone],
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeDasharray: String(circumference),
          strokeDashoffset: String(circumference * (1 - ratio)),
          transform: `rotate(-90 ${String(center)} ${String(center)})`,
        }),
      );
    }

    /** Last successful payload plus its failure, shared by every mounted chip. */
    let cached = null;
    /** Mounted chips subscribing to refresh results. */
    const listeners = new Set();
    /** One in-flight request at a time, so N chips poll once. */
    let inflight = null;

    /**
     * Fetch the host snapshot once and hand it to every subscriber.
     * @returns the payload, or a failure payload when the request failed.
     */
    async function load() {
      const run = async () => {
        try {
          const response = await fetch(SNAPSHOT_ROUTE, { headers: { accept: 'application/json' }, cache: 'no-store' });
          if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
          cached = await response.json();
        } catch (error) {
          const failure = { code: 'connect', message: String(error?.message ?? error) };
          cached = cached === null
            ? { ok: false, fetchedAt: null, windows: null, stale: false, error: failure }
            : { ...cached, stale: true, error: failure };
        }
        for (const listener of listeners) listener(cached);
        return cached;
      };
      inflight ??= run().finally(() => {
        inflight = null;
      });
      return inflight;
    }

    /**
     * Subscribe to refresh results.
     * @param listener - called with each payload.
     * @returns the unsubscribe function.
     */
    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    /**
     * Work out the session's active provider, when the host exposes it.
     * @param ctx - the plugin context.
     * @param sessionId - the session this chip renders for.
     * @returns the provider id, or null when it cannot be read.
     */
    function activeProvider(ctx, sessionId) {
      const directories = ctx.get?.('modelDirectories');
      if (directories === undefined || typeof directories.directoryFor !== 'function') return null;
      try {
        const directory = directories.directoryFor(sessionId);
        const snapshot = typeof directory?.getSnapshot === 'function' ? directory.getSnapshot() : directory?.snapshot;
        const selection = snapshot?.selection ?? snapshot?.current ?? snapshot?.value;
        return typeof selection?.provider === 'string' ? selection.provider : null;
      } catch {
        return null;
      }
    }

    /**
     * A ticking clock, so countdowns and the sample age stay live.
     * @param intervalMs - tick period.
     * @returns the current timestamp.
     */
    function useNow(intervalMs) {
      const [now, setNow] = useState(() => Date.now());
      useEffect(() => {
        const timer = window.setInterval(() => {
          setNow(Date.now());
        }, intervalMs);
        return () => {
          window.clearInterval(timer);
        };
      }, [intervalMs]);
      return now;
    }

    /**
     * Report whether a node is, or contains, the event target.
     * @param node - candidate ancestor.
     * @param target - the event target.
     * @returns whether the target is inside the node.
     */
    function contains(node, target) {
      return node !== null && target instanceof Node ? node.contains(target) : false;
    }

    /**
     * The quota chip and its detail panel.
     *
     * Compact by default — a ring plus the most-used window's figure, sized and
     * coloured like the context meter beside it — and it opens a progress-bar
     * panel on hover, focus, or click.
     * @param props - the slot props (locale seat and injected session facts).
     * @returns the chip element.
     */
    function UsageBar(props) {
      const language = props.language === 'zh' ? 'zh' : 'en';
      const [payload, setPayload] = useState(cached);
      const [busy, setBusy] = useState(cached === null);
      const [open, setOpen] = useState(false);
      const [hovered, setHovered] = useState(false);
      const [refreshHovered, setRefreshHovered] = useState(false);
      const [position, setPosition] = useState(null);
      const rootRef = useRef(null);
      const panelRef = useRef(null);
      const closeTimer = useRef(null);
      const now = useNow(1_000);

      useEffect(() => {
        const unsubscribe = subscribe((next) => {
          setPayload(next);
        });
        return unsubscribe;
      }, []);

      const refresh = useCallback(() => {
        setBusy(true);
        void load().finally(() => {
          setBusy(false);
        });
      }, []);

      useEffect(() => {
        const timer = window.setInterval(refresh, REFRESH_MS);
        const onVisible = () => {
          if (document.visibilityState === 'visible') refresh();
        };
        document.addEventListener('visibilitychange', onVisible);
        if (cached === null) refresh();
        return () => {
          window.clearInterval(timer);
          document.removeEventListener('visibilitychange', onVisible);
        };
      }, [refresh]);

      /** Cancel a pending hover-out close. */
      const cancelClose = useCallback(() => {
        if (closeTimer.current !== null) {
          window.clearTimeout(closeTimer.current);
          closeTimer.current = null;
        }
      }, []);

      /** Close shortly after the pointer leaves both the chip and its panel. */
      const scheduleClose = useCallback(() => {
        cancelClose();
        closeTimer.current = window.setTimeout(() => {
          closeTimer.current = null;
          setOpen(false);
        }, CLOSE_DELAY_MS);
      }, [cancelClose]);

      // Anchor the panel above the chip, clamped to the viewport. Measured while
      // open, so scrolling and resizing keep it attached.
      useEffect(() => {
        if (!open) {
          setPosition(null);
          return undefined;
        }
        const place = () => {
          const node = rootRef.current;
          if (node === null) return;
          const rect = node.getBoundingClientRect();
          const width = Math.min(PANEL_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
          const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.right - width, window.innerWidth - width - VIEWPORT_MARGIN));
          const bottom = Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.top + 8);
          setPosition({ left, bottom, width });
        };
        place();
        window.addEventListener('scroll', place, true);
        window.addEventListener('resize', place);
        return () => {
          window.removeEventListener('scroll', place, true);
          window.removeEventListener('resize', place);
        };
      }, [open]);

      useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        const onPointerDown = (event) => {
          if (contains(rootRef.current, event.target) || contains(panelRef.current, event.target)) return;
          setOpen(false);
        };
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => {
          document.removeEventListener('keydown', onKeyDown);
          document.removeEventListener('pointerdown', onPointerDown, true);
        };
      }, [open]);

      useEffect(
        () => () => {
          cancelClose();
        },
        [cancelClose],
      );

      const windows = payload?.windows ?? null;
      const failure = payload?.error ?? null;
      const summary =
        failure !== null
          ? `${t(language, 'title')} · ${t(language, failure.code)}`
          : WINDOWS.every((name) => windows?.[name] === undefined)
            ? t(language, 'loading')
            : `${t(language, 'title')} · ${WINDOWS.map((name) => {
                const figures = windowFigures(windows?.[name], now);
                return figures.used === null ? t(language, name) : `${t(language, name)} ${t(language, 'used', { percent: figures.used })}`;
              }).join(' · ')}`;

      // One ring per window, no text: each ring's own tooltip carries its detail.
      const rings = WINDOWS.map((name) => {
        const window = windows?.[name];
        const figures = windowFigures(window, now);
        const resetText =
          figures.resetsAt === null
            ? t(language, 'resetPending')
            : t(language, 'resetIn', { time: figures.countdown ?? '—' });
        const label =
          figures.used === null
            ? `${t(language, 'title')} · ${t(language, name)}`
            : t(language, 'ring', {
                window: t(language, name),
                used: t(language, 'used', { percent: figures.used }),
                remaining: String(figures.remaining),
                reset: resetText,
              });
        return React.createElement(
          'span',
          { key: name, style: styles.ringSlot, title: label },
          React.createElement(QuotaRing, {
            percent: figures.used,
            // Without a percentage the ring cannot grade itself: an unreachable
            // or rejected upstream shows the error tone, a pending first sample
            // stays muted.
            tone: figures.used === null ? (failure === null ? 'muted' : 'danger') : toneOf(figures.used),
          }),
        );
      });

      const header = React.createElement(
        'span',
        {
          ref: rootRef,
          style: styles.root,
          onMouseEnter: () => {
            cancelClose();
            setHovered(true);
            setOpen(true);
          },
          onMouseLeave: () => {
            setHovered(false);
            scheduleClose();
          },
        },
        React.createElement(
          'button',
          {
            type: 'button',
            style: hovered || open ? { ...styles.trigger, ...styles.triggerHover } : styles.trigger,
            title: summary,
            'aria-label': summary,
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            onClick: () => setOpen(!open),
            onFocus: () => {
              cancelClose();
              setOpen(true);
            },
            onBlur: scheduleClose,
          },
          React.createElement('span', { style: styles.rings }, rings),
        ),
      );

      if (!open || position === null) return header;

      const ageWords =
        payload?.fetchedAt == null
          ? t(language, 'loading')
          : (() => {
              const age = Math.max(0, now - Date.parse(payload.fetchedAt));
              return age < 60_000 ? t(language, 'updatedJustNow') : t(language, 'updatedAgo', { time: formatDuration(age) ?? '1m' });
            })();

      const rows = WINDOWS.filter((name) => windows?.[name] !== undefined).map((name) => {
        const figures = windowFigures(windows[name], now);
        const used = figures.used;
        const resetText =
          figures.resetsAt === null
            ? t(language, 'resetPending')
            : t(language, 'resetIn', { time: figures.countdown ?? '—' });
        return React.createElement(
          'div',
          { key: name, style: styles.row },
          React.createElement(
            'div',
            { style: styles.rowHead },
            React.createElement('span', { style: styles.rowLabel }, t(language, name)),
            React.createElement('span', { style: styles.rowPercent }, used === null ? '—' : t(language, 'used', { percent: used })),
          ),
          React.createElement(
            'span',
            { style: payload?.stale ? { ...styles.track, ...styles.trackStale } : styles.track },
            React.createElement('span', {
              style: { ...styles.fill, width: `${String(used ?? 0)}%`, background: TONES[toneOf(used)] },
            }),
          ),
          React.createElement(
            'div',
            { style: styles.rowNote },
            used === null
              ? resetText
              : t(language, 'description', { remaining: String(figures.remaining), reset: resetText }),
          ),
        );
      });

      const body = React.createElement(
        'div',
        {
          ref: panelRef,
          style: { ...styles.panel, left: position.left, bottom: position.bottom, width: position.width },
          role: 'dialog',
          'aria-label': t(language, 'title'),
          onMouseEnter: cancelClose,
          onMouseLeave: scheduleClose,
        },
        React.createElement(
          'div',
          { style: styles.panelHeader },
          React.createElement('span', { style: styles.panelTitle }, t(language, 'title')),
          React.createElement('span', { style: styles.panelAge }, ageWords),
        ),
        windows === null
          ? React.createElement('div', { style: { ...styles.row, ...styles.errorText } }, t(language, failure?.code ?? 'unknown'))
          : rows,
        React.createElement(
          'div',
          { style: styles.footer },
          React.createElement('span', { style: payload?.stale ? styles.staleNote : undefined }, payload?.stale ? t(language, 'stale') : t(language, 'detail')),
          React.createElement(
            'button',
            {
              type: 'button',
              style: refreshHovered ? { ...styles.refresh, ...styles.refreshHover } : styles.refresh,
              title: t(language, 'refresh'),
              'aria-label': t(language, 'refresh'),
              onClick: refresh,
              onMouseEnter: () => setRefreshHovered(true),
              onMouseLeave: () => setRefreshHovered(false),
            },
            busy ? t(language, 'refreshing') : '↻',
          ),
        ),
      );

      // A portal keeps the panel out of the composer's clipping and stacking
      // context, exactly like the context meter's own panel.
      return React.createElement(React.Fragment, null, header, ReactDOM.createPortal(body, document.body));
    }

    /** Required client services. */
    const inject = ['slots'];

    /**
     * Register the quota chip in the Composer dock.
     *
     * A client entry that throws fails the whole web boot ("1 entry did not
     * activate"), so every failure here is caught and logged: a broken usage bar
     * must cost the bar, never the application.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      try {
        const slots = ctx.get?.('slots') ?? ctx.slots;
        if (slots === undefined || typeof slots.inject !== 'function') {
          ctx.logger?.warn?.('opencode-go-usage: no slot registry is available; the usage bar stays unmounted');
          return;
        }
        slots.inject('conversation.composer.dock', () =>
          slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'opencode-go-usage',
              order: 30,
              inject: (sessionId) => ({ language: undefined, sessionId, provider: activeProvider(ctx, sessionId) }),
            },
            UsageBar,
          ),
        );
      } catch (error) {
        ctx.logger?.warn?.(`opencode-go-usage: could not register the usage bar: ${String(error?.message ?? error)}`);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.UsageBar = UsageBar;
    exports.QuotaRing = QuotaRing;
    return module.exports;
  },
});
