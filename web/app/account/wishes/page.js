import Link from "next/link";
import { Lightbulb } from "lucide-react";
import { userApiGet } from "../../../lib/user-api";

export const dynamic = "force-dynamic";

const labels = { pending: "待审核", reviewing: "审核中", published: "已公开", planned: "已计划", building: "实现中", shipped: "已上线", declined: "未采用", merged: "已合并" };

export default async function AccountWishesPage() {
  const data = await userApiGet("/api/account/wishes", null);
  if (!data) {
    return <section className="rounded-lg border border-slate-200 bg-white p-8 text-center"><h1 className="text-2xl font-semibold">登录后查看我的愿望</h1><p className="mt-2 text-sm text-slate-500">审核、合并和实现进度会显示在这里。</p><Link href="/account/login?next=/account/wishes" className="mt-5 inline-flex rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white">手机号登录</Link></section>;
  }
  const wishes = Array.isArray(data.wishes) ? data.wishes : [];
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-6">
      <div className="flex items-center justify-between gap-4"><div><h1 className="text-2xl font-semibold">我的愿望</h1><p className="mt-2 text-sm text-slate-500">查看私密提交、审核说明和合并去向。</p></div><Link href="/wishes#make-a-wish" className="rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white">许一个愿望</Link></div>
      <div className="mt-6 grid gap-4">{wishes.length ? wishes.map((wish) => (
        <article key={wish.id} className="rounded-lg border border-slate-200 p-5">
          <div className="flex items-start justify-between gap-4"><div><div className="flex items-center gap-2 text-sm text-brand"><Lightbulb size={15} />{wish.category}</div><h2 className="mt-2 font-semibold">{wish.title}</h2></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{labels[wish.status] || wish.status}</span></div>
          {wish.submitterStatusNote ? <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{wish.submitterStatusNote}</p> : null}
          {wish.mergedIntoId ? <Link className="mt-3 inline-flex text-sm font-semibold text-brand" href={`/wishes`}>查看合并后的公开愿望：{wish.mergedIntoId}</Link> : null}
        </article>
      )) : <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">还没有提交愿望。</div>}</div>
    </section>
  );
}
