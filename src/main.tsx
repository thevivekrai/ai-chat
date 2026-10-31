import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import './index.css'
import { App } from './App'
import { go } from './routing/router'
import { registerServiceWorker } from './store/notifications'

// Scammers ask people to paste code here to take over their account ("self-XSS"): say so plainly.
if (import.meta.env.PROD) {
  console.log('%cStop!', 'color:#dc2626;font-size:40px;font-weight:700')
  console.log(
    '%cThis is a browser tool for developers. If someone told you to paste something here, it is a scam to get into your Sytext account and your chats. Close this panel.',
    'font-size:15px',
  )
}

// Notifications of new messages, and opening the chat when one is tapped (see public/sw.js).
void registerServiceWorker((path) => go(path))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
