import { useState } from 'react'

/** Served from `public/` — add `logo.svg` and/or `logo.png` (SVG first). */
const LOGIN_SOURCES = ['/logo.svg', '/logo.png'] as const

export function AppLogo() {
  const [i, setI] = useState(0)
  const failed = i >= LOGIN_SOURCES.length
  const src = failed ? '' : LOGIN_SOURCES[i]

  if (failed) {
    return (
      <span className="brand" aria-label="Canary">
        Canary
      </span>
    )
  }

  return (
    <img
      src={src}
      alt="Canary"
      className="appLogo appLogo--login"
      onError={() => setI((n) => n + 1)}
    />
  )
}
