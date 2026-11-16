import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createHashRouter, Navigate, RouterProvider } from 'react-router-dom'
import 'mahgen'
import './index.css'
import './i18n'
import './stores/themeStore'
import App from './App.tsx'
import { Settings } from '@/routes/Settings'
import { Overlay } from '@/routes/Overlay'
import { currentWindowLabel } from '@/lib/window'

const root = createRoot(document.getElementById('root')!)
const label = currentWindowLabel()
if (label === 'settings') {
  root.render(<StrictMode><Settings /></StrictMode>)
} else if (label === 'overlay') {
  document.documentElement.classList.add('overlay-window')
  root.render(<StrictMode><Overlay /></StrictMode>)
} else {
  const router = createHashRouter([{
    element: <App />,
    children: [
      { index: true, element: null },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  }])
  root.render(<StrictMode><RouterProvider router={router} /></StrictMode>)
}
