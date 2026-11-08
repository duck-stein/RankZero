import { applyTheme } from './lib/theme'
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { SessionProvider } from './context/SessionContext.jsx'
import './index.css'

applyTheme()

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <SessionProvider>
      <App />
    </SessionProvider>
  </React.StrictMode>
)
