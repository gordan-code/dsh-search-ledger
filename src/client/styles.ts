/**
 * 设置面板嵌入宿主应用。所有选择器都限制在本地根节点下，避免影响宿主外壳。
 * 此处不会请求外部字体或样式表。
 */
export const billingStyles = `
.dsh-web-billing {
  --dsh-bg: #f7f8fa;
  --dsh-surface: #ffffff;
  --dsh-surface-subtle: #f1f3f5;
  --dsh-border: #e1e5ea;
  --dsh-border-strong: #c9d0d8;
  --dsh-text: #1f252d;
  --dsh-muted: #6f7782;
  --dsh-primary: #2463eb;
  --dsh-primary-soft: #e9efff;
  --dsh-success: #18864b;
  --dsh-success-soft: #e4f6ec;
  --dsh-warning: #a45b00;
  --dsh-warning-soft: #fff3dc;
  --dsh-danger: #bf3c3c;
  --dsh-danger-soft: #fff0f0;
  color: var(--dsh-text);
  background: var(--dsh-bg);
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  overflow-wrap: anywhere;
  max-width: 1120px;
  margin: 0 auto;
  padding: 24px clamp(14px, 3vw, 32px) 40px;
  font-size: 14px;
  line-height: 1.5;
}
.dsh-web-billing *, .dsh-web-billing *::before, .dsh-web-billing *::after { box-sizing: border-box; }
.dsh-web-billing > *, .dsh-web-billing .dsh-header, .dsh-web-billing .dsh-header-copy,
.dsh-web-billing .dsh-stack, .dsh-web-billing .dsh-card, .dsh-web-billing .dsh-card-header,
.dsh-web-billing .dsh-card-actions, .dsh-web-billing .dsh-channel-grid,
.dsh-web-billing .dsh-channel-grid > *, .dsh-web-billing .dsh-form-grid,
.dsh-web-billing .dsh-price-grid, .dsh-web-billing .dsh-price-row,
.dsh-web-billing .dsh-route-grid, .dsh-web-billing .dsh-route-card,
.dsh-web-billing .dsh-route-row { min-width: 0; }
.dsh-web-billing h1, .dsh-web-billing h2, .dsh-web-billing h3,
.dsh-web-billing p { margin: 0; }
.dsh-web-billing h1 { font-size: clamp(22px, 3vw, 30px); line-height: 1.2; letter-spacing: -.02em; }
.dsh-web-billing h2 { font-size: 19px; line-height: 1.3; }
.dsh-web-billing h3 { font-size: 15px; line-height: 1.35; }
.dsh-web-billing code { font-size: .9em; color: var(--dsh-muted); overflow-wrap: anywhere; }
.dsh-web-billing button, .dsh-web-billing input, .dsh-web-billing select {
  font: inherit;
}
.dsh-web-billing button {
  white-space: nowrap;
  flex-shrink: 0;
  max-width: 100%;
  min-height: 34px;
  border: 1px solid var(--dsh-border-strong);
  border-radius: 7px;
  background: var(--dsh-surface);
  color: var(--dsh-text);
  padding: 6px 12px;
  cursor: pointer;
  transition: background .15s ease, border-color .15s ease, color .15s ease;
}
.dsh-web-billing button:hover:not(:disabled) { border-color: var(--dsh-primary); background: var(--dsh-primary-soft); }
.dsh-web-billing button:focus-visible, .dsh-web-billing input:focus-visible,
.dsh-web-billing select:focus-visible { outline: 2px solid var(--dsh-primary); outline-offset: 2px; }
.dsh-web-billing button:disabled, .dsh-web-billing input:disabled,
.dsh-web-billing select:disabled { cursor: not-allowed; opacity: .55; }
.dsh-web-billing .dsh-button-primary { background: var(--dsh-primary); border-color: var(--dsh-primary); color: #fff; }
.dsh-web-billing .dsh-button-primary:hover:not(:disabled) { background: #1b50c2; border-color: #1b50c2; }
.dsh-web-billing .dsh-button-danger { color: var(--dsh-danger); border-color: #e2a4a4; }
.dsh-web-billing .dsh-button-danger:hover:not(:disabled) { background: var(--dsh-danger-soft); border-color: var(--dsh-danger); }
.dsh-web-billing input, .dsh-web-billing select {
  min-width: 0;
  max-width: 100%;
  min-height: 34px;
  border: 1px solid var(--dsh-border-strong);
  border-radius: 6px;
  background: var(--dsh-surface);
  color: var(--dsh-text);
  padding: 6px 9px;
}
.dsh-web-billing input[type="checkbox"] { min-height: auto; accent-color: var(--dsh-primary); }
.dsh-web-billing input[type="datetime-local"] { width: 100%; max-width: 100%; min-width: 0; }
.dsh-web-billing .dsh-eyebrow { color: var(--dsh-primary); font-size: 11px; font-weight: 700; letter-spacing: .11em; text-transform: uppercase; }
.dsh-web-billing .dsh-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 20px; }
.dsh-web-billing .dsh-header-copy { display: grid; gap: 5px; }
.dsh-web-billing .dsh-subtitle { color: var(--dsh-muted); max-width: 680px; }
.dsh-web-billing .dsh-status-pill, .dsh-web-billing .dsh-badge {
  display: inline-flex; align-items: center; gap: 6px; width: fit-content;
  border-radius: 999px; padding: 4px 9px; font-size: 12px; font-weight: 650;
  white-space: nowrap;
}
.dsh-web-billing .dsh-status-pill::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.dsh-web-billing .dsh-status-ok, .dsh-web-billing .dsh-badge-success { color: var(--dsh-success); background: var(--dsh-success-soft); }
.dsh-web-billing .dsh-status-warn, .dsh-web-billing .dsh-badge-warning { color: var(--dsh-warning); background: var(--dsh-warning-soft); }
.dsh-web-billing .dsh-status-error, .dsh-web-billing .dsh-badge-danger { color: var(--dsh-danger); background: var(--dsh-danger-soft); }
.dsh-web-billing .dsh-badge-neutral { color: var(--dsh-muted); background: var(--dsh-surface-subtle); }
.dsh-web-billing .dsh-status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-bottom: 18px; }
.dsh-web-billing .dsh-status-card { background: var(--dsh-surface); border: 1px solid var(--dsh-border); border-radius: 10px; padding: 13px 14px; min-width: 0; }
.dsh-web-billing .dsh-status-card h3 { margin-bottom: 5px; }
.dsh-web-billing .dsh-status-card p { color: var(--dsh-muted); overflow-wrap: anywhere; }
.dsh-web-billing .dsh-status-card .dsh-status-pill { margin-bottom: 5px; }
.dsh-web-billing .dsh-alert { border: 1px solid #e4b2b2; border-radius: 8px; background: var(--dsh-danger-soft); color: var(--dsh-danger); padding: 10px 12px; }
.dsh-web-billing .dsh-notice { border: 1px solid var(--dsh-border); border-radius: 8px; background: var(--dsh-surface-subtle); color: var(--dsh-muted); padding: 10px 12px; }
.dsh-web-billing .dsh-guidance { display: grid; gap: 5px; margin: 14px 0; }
.dsh-web-billing .dsh-guidance strong { color: var(--dsh-text); }
.dsh-web-billing .dsh-guidance ol { margin: 0; padding-left: 22px; }
.dsh-web-billing .dsh-tabs { display: flex; gap: 3px; border-bottom: 1px solid var(--dsh-border); margin-bottom: 18px; overflow-x: auto; }
.dsh-web-billing .dsh-tab { border: 0; border-radius: 7px 7px 0 0; background: transparent; color: var(--dsh-muted); min-height: 39px; padding: 8px 14px; white-space: nowrap; }
.dsh-web-billing .dsh-tab:hover:not(:disabled) { background: var(--dsh-surface-subtle); }
.dsh-web-billing .dsh-tab[aria-selected="true"] { color: var(--dsh-primary); background: var(--dsh-primary-soft); box-shadow: inset 0 -2px 0 var(--dsh-primary); }
.dsh-web-billing .dsh-stack { display: grid; gap: 14px; }
.dsh-web-billing .dsh-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.dsh-web-billing .dsh-toolbar-spacer { flex: 1; }
.dsh-web-billing .dsh-card { border: 1px solid var(--dsh-border); border-radius: 10px; background: var(--dsh-surface); padding: 16px; }
.dsh-web-billing .dsh-card-header { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 14px; margin-bottom: 12px; }
.dsh-web-billing .dsh-card-header > :first-child { flex: 1 1 280px; min-width: 0; }
.dsh-web-billing .dsh-card-header p { color: var(--dsh-muted); margin-top: 3px; }
.dsh-web-billing .dsh-card-actions { display: flex; flex: 0 1 auto; max-width: 100%; flex-wrap: wrap; justify-content: flex-end; gap: 7px; }
.dsh-web-billing .dsh-add-channel { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; max-width: 100%; }
.dsh-web-billing .dsh-add-channel .dsh-select { flex: 1 1 150px; width: auto; max-width: 230px; min-width: 0; }
.dsh-web-billing .dsh-select { display: inline-block; width: 100%; min-width: 0; max-width: 100%; vertical-align: middle; }
.dsh-web-billing .dsh-select-trigger { display: flex; width: 100%; min-width: 0; align-items: center; justify-content: space-between; gap: 12px; text-align: left; padding: 6px 9px; }
.dsh-web-billing .dsh-select-trigger > :first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-web-billing .dsh-select-trigger > :last-child { flex-shrink: 0; color: var(--dsh-muted); }
.dsh-web-billing .dsh-select-trigger[aria-expanded="true"] { border-color: var(--dsh-primary); }
.dsh-web-billing .dsh-select-menu { position: fixed; inset: auto; margin: 0; padding: 0; z-index: 10000; overflow: auto; overscroll-behavior: contain; border: 1px solid var(--dsh-border-strong); border-radius: 8px; background: var(--dsh-surface); color: var(--dsh-text); box-shadow: 0 6px 22px #0002; max-width: calc(100vw - 16px); scrollbar-width: thin; }
.dsh-web-billing .dsh-select-option { display: flex; align-items: center; min-width: 0; padding: 0 10px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; cursor: pointer; }
.dsh-web-billing .dsh-select-option[aria-selected="true"] { color: var(--dsh-primary); font-weight: 650; }
.dsh-web-billing .dsh-select-option.dsh-select-active { background: var(--dsh-primary-soft); }
.dsh-web-billing .dsh-select-option[aria-disabled="true"] { opacity: .5; cursor: not-allowed; }
.dsh-web-billing .dsh-channel-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); align-items: start; gap: 12px; }
.dsh-web-billing .dsh-channel-card { border: 1px solid var(--dsh-border); border-radius: 10px; background: var(--dsh-surface); padding: 15px; min-width: 0; }
.dsh-web-billing .dsh-channel-card[aria-disabled="true"] { opacity: .72; }
.dsh-web-billing .dsh-channel-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; min-width: 0; }
.dsh-web-billing .dsh-channel-title h3 { overflow-wrap: anywhere; }
.dsh-web-billing .dsh-channel-meta { color: var(--dsh-muted); font-size: 12px; margin-top: 2px; }
.dsh-web-billing .dsh-channel-grid { grid-template-columns: minmax(0, 1fr); }
.dsh-web-billing .dsh-channel-disclosure > summary { cursor: pointer; list-style: none; align-items: center; margin-bottom: 0; }
.dsh-web-billing .dsh-channel-disclosure > summary::-webkit-details-marker { display: none; }
.dsh-web-billing .dsh-channel-disclosure > summary::after { content: '⌄'; color: var(--dsh-muted); flex-shrink: 0; }
.dsh-web-billing .dsh-channel-disclosure[open] > summary::after { content: '⌃'; }
.dsh-web-billing .dsh-channel-heading { flex: 1; min-width: 0; }
.dsh-web-billing .dsh-channel-order { color: var(--dsh-muted); background: var(--dsh-surface-subtle); border-radius: 20px; padding: 3px 9px; font-size: 12px; }
.dsh-web-billing .dsh-channel-advanced { margin-top: 14px; border-top: 1px solid var(--dsh-border); padding-top: 12px; }
.dsh-web-billing .dsh-channel-advanced > summary { color: var(--dsh-muted); cursor: pointer; font-size: 13px; margin-bottom: 10px; }
.dsh-web-billing .dsh-credential-box { display: grid; gap: 12px; min-width: 0; margin-top: 16px; border-top: 1px solid var(--dsh-border); padding-top: 16px; }
.dsh-web-billing .dsh-credential-label { display: grid; gap: 7px; font-size: 13px; min-width: 0; color: var(--dsh-muted); }
.dsh-web-billing .dsh-credential-box textarea { width: 100%; max-width: 100%; min-width: 0; min-height: 88px; resize: vertical; border: 1px solid var(--dsh-border-strong); border-radius: 8px; background: var(--dsh-surface); color: var(--dsh-text); font: inherit; padding: 12px; overflow-wrap: anywhere; }
.dsh-web-billing .dsh-credential-box textarea:focus { outline: 2px solid var(--dsh-primary); outline-offset: 1px; }
.dsh-web-billing .dsh-credential-box textarea:disabled { opacity: .65; background: var(--dsh-surface-subtle); }
.dsh-web-billing .dsh-key-test-toolbar { display: flex; flex-wrap: wrap; align-items: end; gap: 10px; min-width: 0; }
.dsh-web-billing .dsh-key-test-toolbar > label { display: grid; gap: 4px; min-width: 0; flex: 0 1 130px; color: var(--dsh-muted); font-size: 12px; }
.dsh-web-billing .dsh-key-test-toolbar select { width: 100%; }
.dsh-web-billing .dsh-key-test-results { display: grid; gap: 9px; min-width: 0; background: var(--dsh-surface-subtle); border: 1px solid var(--dsh-border); padding: 12px; border-radius: 8px; }
.dsh-web-billing .dsh-key-test-row { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; min-width: 0; }
.dsh-web-billing .dsh-form-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
.dsh-web-billing .dsh-form-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
.dsh-web-billing .dsh-form-row > label { display: inline-flex; flex: 1 1 180px; align-items: center; gap: 7px; min-width: 0; }
.dsh-web-billing .dsh-form-row > label > input:not([type="checkbox"]), .dsh-web-billing .dsh-form-row > label > select { flex: 1; min-width: 0; }
.dsh-web-billing .dsh-form-grid > label { min-width: 0; }
.dsh-web-billing .dsh-form-grid > label > input:not([type="checkbox"]), .dsh-web-billing .dsh-form-grid > label > select { width: 100%; min-width: 0; }
.dsh-web-billing .dsh-check { display: inline-flex; align-items: center; gap: 7px; }
.dsh-web-billing .dsh-price-grid { display: grid; gap: 8px; margin-top: 10px; }
.dsh-web-billing .dsh-price-row { display: grid; grid-template-columns: minmax(58px, .55fr) minmax(0, 1fr) minmax(68px, .62fr) minmax(0, 1fr); gap: 8px; align-items: end; }
.dsh-web-billing .dsh-price-row > label { display: grid; gap: 4px; min-width: 0; color: var(--dsh-muted); }
.dsh-web-billing .dsh-price-row > label input, .dsh-web-billing .dsh-price-row > label select { width: 100%; min-width: 0; }
.dsh-web-billing .dsh-price-row .dsh-price-label { color: var(--dsh-muted); font-weight: 650; }
.dsh-web-billing .dsh-inline-note { color: var(--dsh-muted); font-size: 12px; }
.dsh-web-billing .dsh-inline-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.dsh-web-billing .dsh-action-note { margin-top: 9px; color: var(--dsh-muted); font-size: 12px; }
.dsh-web-billing .dsh-error-note { color: var(--dsh-danger); font-size: 12px; margin-top: 7px; }
.dsh-web-billing .dsh-route-grid { display: grid; gap: 12px; }
.dsh-web-billing .dsh-route-card { border: 1px solid var(--dsh-border); border-radius: 10px; background: var(--dsh-surface); overflow: hidden; }
.dsh-web-billing .dsh-route-card-header { padding: 13px 15px; border-bottom: 1px solid var(--dsh-border); display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
.dsh-web-billing .dsh-route-card-header p { color: var(--dsh-muted); font-size: 12px; }
.dsh-web-billing .dsh-route-row { display: grid; grid-template-columns: minmax(72px, .22fr) minmax(0, 1fr); gap: 6px 12px; align-items: center; padding: 11px 15px; border-bottom: 1px solid var(--dsh-border); }
.dsh-web-billing .dsh-route-row > * { min-width: 0; max-width: 100%; }
.dsh-web-billing .dsh-route-row:last-child { border-bottom: 0; }
.dsh-web-billing .dsh-route-operation { font-weight: 650; }
.dsh-web-billing .dsh-route-effective { grid-column: 2; color: var(--dsh-muted); font-size: 12px; min-width: 0; overflow-wrap: anywhere; }
.dsh-web-billing .dsh-route-effective .dsh-badge { max-width: 100%; white-space: normal; }
.dsh-web-billing .dsh-route-select { width: 100%; max-width: 100%; min-width: 0; }
.dsh-web-billing .dsh-failover-box, .dsh-web-billing .dsh-candidate-preview { margin-top: 14px; border: 1px solid var(--dsh-border); border-radius: 10px; background: var(--dsh-surface-subtle); padding: 13px 15px; min-width: 0; }
.dsh-web-billing .dsh-failover-intro { display: grid; gap: 3px; margin-bottom: 10px; }
.dsh-web-billing .dsh-failover-intro p, .dsh-web-billing .dsh-candidate-preview p { color: var(--dsh-muted); font-size: 12px; }
.dsh-web-billing .dsh-failover-grid { grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); }
.dsh-web-billing .dsh-failover-card { background: var(--dsh-surface); }
.dsh-web-billing .dsh-failover-inputs { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); padding: 10px 15px 0; }
.dsh-web-billing .dsh-failover-inputs > label, .dsh-web-billing .dsh-candidate-preview > .dsh-form-row > label { display: grid; gap: 5px; min-width: 0; }
.dsh-web-billing .dsh-failover-inputs input, .dsh-web-billing .dsh-candidate-preview select { width: 100%; min-width: 0; }
.dsh-web-billing .dsh-failover-card > .dsh-inline-note { padding: 0 15px 12px; }
.dsh-web-billing .dsh-candidate-preview > .dsh-form-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); margin-top: 10px; }
.dsh-web-billing .dsh-candidate-list { display: grid; gap: 7px; margin: 10px 0 0; padding-left: 24px; }
.dsh-web-billing .dsh-candidate-list li { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.dsh-web-billing .dsh-candidate-list li > span { color: var(--dsh-muted); font-size: 12px; }
.dsh-web-billing .dsh-session-box { margin-top: 14px; }
.dsh-web-billing .dsh-session-result { display: grid; gap: 10px; margin-top: 12px; }
.dsh-web-billing .dsh-filter-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 10px; align-items: end; }
.dsh-web-billing .dsh-filter-grid label { display: grid; gap: 5px; color: var(--dsh-muted); min-width: 0; }
.dsh-web-billing .dsh-filter-grid input, .dsh-web-billing .dsh-filter-grid select { width: 100%; }
.dsh-web-billing .dsh-summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 9px; }
.dsh-web-billing .dsh-summary-card { border: 1px solid var(--dsh-border); border-radius: 8px; padding: 11px 12px; background: var(--dsh-surface-subtle); }
.dsh-web-billing .dsh-summary-card strong { display: block; font-size: 16px; }
.dsh-web-billing .dsh-summary-card span { color: var(--dsh-muted); font-size: 12px; }
.dsh-web-billing .dsh-table-wrap { overflow-x: auto; border: 1px solid var(--dsh-border); border-radius: 9px; background: var(--dsh-surface); }
.dsh-web-billing table { width: 100%; min-width: 760px; border-collapse: collapse; text-align: left; }
.dsh-web-billing th, .dsh-web-billing td { border-bottom: 1px solid var(--dsh-border); padding: 10px 11px; vertical-align: top; }
.dsh-web-billing th { color: var(--dsh-muted); font-size: 12px; font-weight: 650; background: var(--dsh-surface-subtle); white-space: nowrap; }
.dsh-web-billing tbody tr:last-child td { border-bottom: 0; }
.dsh-web-billing .dsh-empty { border: 1px dashed var(--dsh-border-strong); border-radius: 9px; padding: 22px 15px; text-align: center; color: var(--dsh-muted); background: var(--dsh-surface); }
.dsh-web-billing .dsh-empty strong { display: block; color: var(--dsh-text); margin-bottom: 3px; }
.dsh-web-billing .dsh-recent-list { display: grid; gap: 7px; }
.dsh-web-billing .dsh-recent-item { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; padding: 9px 11px; border: 1px solid var(--dsh-border); border-radius: 7px; }
.dsh-web-billing .dsh-recent-meta { color: var(--dsh-muted); font-size: 12px; }
.dsh-web-billing .dsh-muted { color: var(--dsh-muted); }
@media (max-width: 760px) {
  .dsh-web-billing { padding: 18px 12px 28px; }
  .dsh-web-billing .dsh-header { display: grid; }
  .dsh-web-billing .dsh-card-header { display: grid; grid-template-columns: minmax(0, 1fr); }
  .dsh-web-billing .dsh-card-actions { justify-content: flex-start; }
  .dsh-web-billing .dsh-status-grid { grid-template-columns: 1fr; }
  .dsh-web-billing .dsh-route-row { grid-template-columns: 1fr; gap: 6px; }
  .dsh-web-billing .dsh-route-effective { grid-column: 1 / -1; }
  .dsh-web-billing .dsh-filter-grid { grid-template-columns: 1fr; }
  .dsh-web-billing .dsh-price-row { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: end; }
  .dsh-web-billing .dsh-price-row > .dsh-price-label,
  .dsh-web-billing .dsh-price-row > .dsh-inline-note { grid-column: 1 / -1; }
}
@media (prefers-color-scheme: dark) {
  .dsh-web-billing {
    --dsh-bg: #15171a; --dsh-surface: #202328; --dsh-surface-subtle: #292d33;
    --dsh-border: #383e47; --dsh-border-strong: #515a66; --dsh-text: #f1f4f8; --dsh-muted: #a4adb8;
    --dsh-primary: #79a5ff; --dsh-primary-soft: #26395f; --dsh-success: #6ad39a; --dsh-success-soft: #1f4431;
    --dsh-warning: #f0b861; --dsh-warning-soft: #4a351b; --dsh-danger: #ff9292; --dsh-danger-soft: #4a2626;
  }
  .dsh-web-billing .dsh-button-primary { color: #101726; }
}
`

export default billingStyles
