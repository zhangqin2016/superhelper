import { cn } from "../../lib/utils";

export function Card({ className, ...props }) {
  return <div className={cn("rounded-xl border border-slate-200 bg-white shadow-[0_16px_45px_rgba(15,23,42,0.06)]", className)} {...props} />;
}

export function CardHeader({ className, ...props }) {
  return <div className={cn("flex items-start justify-between gap-4 p-6", className)} {...props} />;
}

export function CardTitle({ className, ...props }) {
  return <h2 className={cn("text-xl font-semibold text-slate-950", className)} {...props} />;
}

export function CardContent({ className, ...props }) {
  return <div className={cn("p-6 pt-0", className)} {...props} />;
}
