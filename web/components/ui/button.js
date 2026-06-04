import { cn } from "../../lib/utils";

export function Button({ className, variant = "default", size = "default", ...props }) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center rounded-lg font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50",
        variant === "default" && "bg-brand text-white hover:bg-brand/90",
        variant === "outline" && "border border-slate-200 bg-white text-slate-800 hover:bg-slate-50",
        variant === "danger" && "border border-red-200 bg-white text-red-700 hover:bg-red-50",
        size === "default" && "px-4 py-2.5 text-sm",
        size === "sm" && "px-3 py-1.5 text-xs",
        className,
      )}
      {...props}
    />
  );
}
