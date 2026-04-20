import type { InputHTMLAttributes } from 'react'

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  onClear?: () => void
  /** Show clear control when non-empty (default true). */
  clearable?: boolean
}

/** Search field with a trailing clear button. */
export function SearchInput({ value, onClear, clearable = true, className, ...rest }: Props) {
  const v = value ?? ''
  const show = clearable && String(v).length > 0
  return (
    <div className={`searchInputWrap${className ? ` ${className}` : ''}`}>
      <input {...rest} value={value} className="searchInputField" />
      {show ? (
        <button
          type="button"
          className="searchInputClear"
          aria-label="Clear search"
          onClick={() => onClear?.()}
        >
          ×
        </button>
      ) : null}
    </div>
  )
}
