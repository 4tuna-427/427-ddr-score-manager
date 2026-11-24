import { useEffect, useState } from 'react'

// Theme mode is stored per device; the resolved theme ('light' | 'dark')
// is exposed as <html data-theme="...">, which styles.css keys off.
// index.html sets data-theme before first paint to avoid a flash.
export type ThemeMode = 'auto' | 'light' | 'dark'

const KEY = 'ddr.theme'

export function getThemeMode(): ThemeMode {
  const v = localStorage.getItem(KEY)
  return v === 'light' || v === 'dark' ? v : 'auto'
}

export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'auto') return mode
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyTheme(mode: ThemeMode = getThemeMode()): void {
  const resolved = resolveTheme(mode)
  document.documentElement.dataset.theme = resolved
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0d120e' : '#51dd95')
}

export function setThemeMode(mode: ThemeMode): void {
  localStorage.setItem(KEY, mode)
  applyTheme(mode)
}

/** Call once at startup: apply the stored mode and follow OS changes in auto. */
export function initTheme(): void {
  applyTheme()
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getThemeMode() === 'auto') applyTheme('auto')
  })
}

/** Reactive dark flag for components that need theme-dependent values (charts). */
export function useIsDark(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark')
  useEffect(() => {
    const update = () => setDark(document.documentElement.dataset.theme === 'dark')
    const obs = new MutationObserver(update)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', update)
    return () => {
      obs.disconnect()
      mq.removeEventListener('change', update)
    }
  }, [])
  return dark
}
