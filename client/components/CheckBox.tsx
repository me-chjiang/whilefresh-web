export interface CheckBoxProps {
  checked: boolean;
}

export function CheckBox({ checked }: CheckBoxProps) {
  return (
    <span
      aria-hidden="true"
      className={`check-box${checked ? " check-box--on" : ""}`}
    >
      {checked && (
        <svg
          viewBox="0 0 24 24"
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          strokeWidth={3.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 12l5 5l10 -10" />
        </svg>
      )}
    </span>
  );
}
