import type { ApprenticeApi } from '../preload/api'

declare global {
  interface Window {
    apprentice: ApprenticeApi
  }
}
