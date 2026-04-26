// Brand tokens — mirrors src/styles/tokens.css. Kept inline so the Rollup
// bundle does not require a CSS import plugin; the .css file remains the
// human-readable source of truth.
const TOKEN_CSS = `:root {
  --hm-primary: #1E3A8A;
  --hm-secondary: #0F766E;
  --hm-accent: #F59E0B;
  --hm-bg: #F8FAFC;
  --hm-text: #0F172A;
  --hm-muted: #64748B;
  --hm-error: #DC2626;
  --hm-font-heading: 'Lora', serif;
  --hm-font-body: 'Lato', sans-serif;
}`;

let installed = false;

export function installTokens(): void {
  if (installed) return;
  if (typeof document === 'undefined') return;
  installed = true;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(TOKEN_CSS);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return;
  } catch {
    // Fall through to legacy <style> injection.
  }
  const style = document.createElement('style');
  style.textContent = TOKEN_CSS;
  document.head.appendChild(style);
}

installTokens();
