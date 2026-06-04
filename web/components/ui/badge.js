import { cn } from "../../lib/utils";

export function Badge({ className, variant = "default", ...props }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold",
        variant === "default" && "bg-slate-100 text-slate-700",
        variant === "success" && "bg-emerald-50 text-emerald-700",
        variant === "danger" && "bg-red-50 text-red-700",
        variant === "brand" && "bg-brand/10 text-brand",
        className,
      )}
      {...props}
    />
  );
}
