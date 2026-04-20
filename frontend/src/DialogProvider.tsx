import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { AlertModal } from './AlertModal'
import { ConfirmModal } from './ConfirmModal'

export type ConfirmOptions = {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

type DialogContextValue = {
  askConfirm: (opts: ConfirmOptions) => Promise<boolean>
  alert: (message: string, title?: string) => Promise<void>
}

const DialogContext = createContext<DialogContextValue | null>(null)

export function useDialogs(): DialogContextValue {
  const v = useContext(DialogContext)
  if (!v) {
    throw new Error('useDialogs must be used within DialogProvider')
  }
  return v
}

/** Optional: no-op when provider missing (e.g. standalone pages). */
export function useDialogsOptional(): DialogContextValue | null {
  return useContext(DialogContext)
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [confirm, setConfirm] = useState<null | { opts: ConfirmOptions; resolve: (v: boolean) => void }>(null)
  const [alertState, setAlertState] = useState<null | { title: string; message: string; resolve: () => void }>(null)

  const askConfirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setConfirm({ opts, resolve })
    })
  }, [])

  const alertFn = useCallback((message: string, title = 'Notice') => {
    return new Promise<void>((resolve) => {
      setAlertState({ title, message, resolve })
    })
  }, [])

  const value = useMemo(() => ({ askConfirm, alert: alertFn }), [askConfirm, alertFn])

  return (
    <DialogContext.Provider value={value}>
      {children}
      {confirm ? (
        <ConfirmModal
          open
          title={confirm.opts.title}
          message={confirm.opts.message}
          confirmLabel={confirm.opts.confirmLabel ?? 'Confirm'}
          cancelLabel={confirm.opts.cancelLabel ?? 'Cancel'}
          danger={confirm.opts.danger}
          onConfirm={() => {
            confirm.resolve(true)
            setConfirm(null)
          }}
          onCancel={() => {
            confirm.resolve(false)
            setConfirm(null)
          }}
        />
      ) : null}
      {alertState ? (
        <AlertModal
          open
          title={alertState.title}
          message={alertState.message}
          onClose={() => {
            alertState.resolve()
            setAlertState(null)
          }}
        />
      ) : null}
    </DialogContext.Provider>
  )
}
