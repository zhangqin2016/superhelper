import { cn } from "../../lib/utils";

export function Table({ className, ...props }) {
  return <table className={cn("w-full text-left text-sm", className)} {...props} />;
}

export function TableHeader({ className, ...props }) {
  return <thead className={cn("bg-slate-50 text-slate-500", className)} {...props} />;
}

export function TableBody({ className, ...props }) {
  return <tbody className={className} {...props} />;
}

export function TableRow({ className, ...props }) {
  return <tr className={cn("border-t border-slate-100", className)} {...props} />;
}

export function TableHead({ className, ...props }) {
  return <th className={cn("px-5 py-4 font-medium", className)} {...props} />;
}

export function TableCell({ className, ...props }) {
  return <td className={cn("px-5 py-4", className)} {...props} />;
}
