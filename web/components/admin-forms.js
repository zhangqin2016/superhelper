export function Field({ label, name, type = "text", defaultValue = "", placeholder = "", required = false }) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-medium text-slate-700">{label}</span>
      <input
        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand"
        name={name}
        type={type}
        defaultValue={defaultValue}
        placeholder={placeholder}
        required={required}
      />
    </label>
  );
}

export function SelectField({ label, name, options, defaultValue }) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-medium text-slate-700">{label}</span>
      <select
        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand"
        name={name}
        defaultValue={defaultValue}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

export function CheckboxField({ label, name }) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-600">
      <input className="h-4 w-4 rounded border-slate-300 text-brand" name={name} type="checkbox" />
      {label}
    </label>
  );
}

export function SubmitButton({ children, disabled = false }) {
  return (
    <button
      className="rounded-lg bg-brand px-4 py-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
      disabled={disabled}
    >
      {children}
    </button>
  );
}
