import React from 'react'
import ReactDOM from 'react-dom/client'

// Self-hosted fonts. These were previously pulled from fonts.googleapis.com,
// which meant a packaged desktop app on a plane, an air-gapped cluster, or
// behind an institutional proxy silently fell back to system fonts — and
// plot theming (fontFamily: 'JetBrains Mono') degraded with it, which shows
// up in exported figures. Bundling them also removes an external request.
import '@fontsource/jetbrains-mono/300.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
// Inter for the interface. Syne — which this used to be — is a geometric
// DISPLAY face: fine on a poster, restless at 13px across a dense tool, which
// is what made the app read as slightly off. Inter is a neo-grotesque cut for
// screen UI at small sizes: Arial's proportions without its dated details.
// Bundled rather than relying on a system font so the packaged app looks the
// same on macOS, Windows and Linux.
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'

import App from './App'
import './styles/global.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
