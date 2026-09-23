'use client';

import { useCallback, useState } from 'react';

type ConfirmOptions = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'primary' | 'danger';
  promptLabel?: string;
  promptPlaceholder?: string;
  promptRequired?: boolean;
};

type ConfirmResult = { confirmed: boolean; value: string };

type PendingConfirm = ConfirmOptions & { resolve: (result: ConfirmResult) => void };

export function useConfirm() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [inputValue, setInputValue] = useState('');

  const confirm = useCallback((options: ConfirmOptions) => {
    setInputValue('');
    return new Promise<ConfirmResult>(resolve => {
      setPending({ ...options, resolve });
    });
  }, []);

  const settle = (confirmed: boolean) => {
    if (!pending) return;
    const value = inputValue.trim();
    if (confirmed && pending.promptRequired && !value) return;
    pending.resolve({ confirmed, value });
    setPending(null);
  };

  const dialog = pending ? (
    <div className="modal-overlay" onClick={event => { if (event.target === event.currentTarget) settle(false); }}>
      <div className="modal-card" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
        <div className="modal-header">
          <h2 id="confirm-dialog-title">{pending.title}</h2>
          <button className="modal-close" onClick={() => settle(false)} aria-label="Close">✕</button>
        </div>
        <p className="modal-message">{pending.message}</p>
        {pending.promptLabel && (
          <label className="field-label" style={{ display: 'block', marginBottom: '0.5rem' }}>
            {pending.promptLabel}
            <textarea
              className="field-input"
              style={{ marginTop: '0.4rem', resize: 'vertical', minHeight: '4.5rem' }}
              value={inputValue}
              onChange={event => setInputValue(event.target.value)}
              placeholder={pending.promptPlaceholder}
              autoFocus
            />
          </label>
        )}
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={() => settle(false)}>{pending.cancelLabel || 'Cancel'}</button>
          <button
            className={`btn ${pending.tone === 'danger' ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => settle(true)}
            disabled={pending.promptRequired ? !inputValue.trim() : false}
          >
            {pending.confirmLabel || 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { confirm, dialog };
}
