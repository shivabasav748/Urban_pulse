import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

// shadcn/ui's Vite dark-mode pattern. Default is light; the choice is remembered per browser.
export type Theme = 'dark' | 'light' | 'system'
const KEY = 'up.theme'
const Ctx = createContext<{ theme: Theme; setTheme: (t: Theme) => void }>({ theme: 'light', setTheme: () => {} })

const read = (): Theme => { try { return (localStorage.getItem(KEY) as Theme | null) ?? 'light' } catch { return 'light' } }

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeRaw] = useState<Theme>(read)
  useEffect(() => {
    const root = document.documentElement
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches)
      root.classList.toggle('dark', dark)
      root.style.colorScheme = dark ? 'dark' : 'light'
    }
    apply()
    if (theme !== 'system') return
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])
  const setTheme = (t: Theme) => { setThemeRaw(t); try { localStorage.setItem(KEY, t) } catch { /* private mode */ } }
  return <Ctx.Provider value={{ theme, setTheme }}>{children}</Ctx.Provider>
}

export const useTheme = () => useContext(Ctx)
