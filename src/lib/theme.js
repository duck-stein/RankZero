// Temas: "sistema" (padrão, escuro/ciano) e "kawaii" (rosa e branco com laços).
// Fica salvo no aparelho (localStorage) e vale na hora, sem mexer no banco.
const KEY = 'rankzero_theme'
export const THEMES = [
  { key: 'sistema', label: 'Sistema', hint: 'Escuro e ciano' },
  { key: 'kawaii', label: 'Rosa kawaii', hint: 'Rosa, branco e laços' },
]
export const getTheme = () => {
  try { return localStorage.getItem(KEY) || 'sistema' } catch { return 'sistema' }
}
export function applyTheme(key = getTheme()) {
  document.documentElement.dataset.theme = key
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', key === 'kawaii' ? '#ffe3ee' : '#080a0f')
}
export function setTheme(key) {
  try { localStorage.setItem(KEY, key) } catch { }
  applyTheme(key)
}
