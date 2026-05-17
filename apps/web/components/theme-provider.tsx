'use client';

/**
 * Theme provider — thin wrapper around `next-themes` so the consumer
 * (`app/layout.tsx`) doesn't have to import the package directly.
 *
 * Configuration choices:
 *   - `attribute="class"` → toggles a `.dark` class on <html>, which matches
 *     our Tailwind `darkMode: ['class']` config.
 *   - `defaultTheme="system"` → first paint follows OS preference.
 *   - `enableSystem` → users can pick System / Light / Dark in Settings and
 *     `useTheme` reflects the resolved value.
 *   - `disableTransitionOnChange` → avoids the entire page transitioning
 *     colors when the user flips the toggle, which can otherwise feel laggy
 *     on slower devices.
 */
import { ThemeProvider as NextThemesProvider } from 'next-themes';
import type { ThemeProviderProps } from 'next-themes';

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
