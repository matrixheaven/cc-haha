import { useState } from 'react'
import { useAuthStore } from '../stores/authStore'
import { useTranslation } from '../i18n'

export function LoginPage() {
  const [password, setPassword] = useState('')
  const { login, isLoading, error } = useAuthStore()
  const t = useTranslation()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!password.trim()) return
    void login(password.trim())
  }

  return (
    <div className="h-screen flex items-center justify-center bg-[var(--color-surface)]">
      <div className="w-full max-w-sm px-6">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold text-[var(--color-text-primary)] mb-2">
            {t('login.title')}
          </h1>
          <p className="text-sm text-[var(--color-text-secondary)]">
            {t('login.subtitle')}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">
              {t('login.password')}
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('login.passwordPlaceholder')}
              autoFocus
              className="w-full text-sm px-3 py-2.5 rounded-[var(--radius-md)] bg-[var(--color-surface-container-low)] border border-[var(--color-border)] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand)] transition-colors"
            />
          </div>

          {error && (
            <div className="text-xs text-[var(--color-error)] bg-[var(--color-error)]/10 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading || !password.trim()}
            className="w-full py-2.5 text-sm font-semibold rounded-lg bg-[var(--color-brand)] text-white hover:bg-[var(--color-brand-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isLoading ? t('common.loading') : t('login.submit')}
          </button>
        </form>
      </div>
    </div>
  )
}
