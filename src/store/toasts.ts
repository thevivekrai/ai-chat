import { create } from 'zustand'

export interface Toast {
  id: string
  title: string
  description?: string
  action?: { label: string; run: () => void }
  /** A new toast replaces an older one in the same group (e.g. rapid "Marked done" undos). */
  group?: string
}

interface ToastState {
  toasts: Toast[]
  push(toast: Omit<Toast, 'id'>): string
  dismiss(id: string): void
}

let counter = 0

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (toast) => {
    const id = `toast-${++counter}`
    // Keep the stack short; the newest toast matters most.
    set((s) => {
      const others = toast.group ? s.toasts.filter((t) => t.group !== toast.group) : s.toasts
      return { toasts: [...others.slice(-2), { ...toast, id }] }
    })
    return id
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

export const toast = (t: Omit<Toast, 'id'>) => useToasts.getState().push(t)
