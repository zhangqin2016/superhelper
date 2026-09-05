"use client";

import Link from "next/link";

export default function EnterpriseError({ reset }) {
  return <section role="alert" className="rounded-lg border bg-white p-6 space-y-4">
    <h1 className="text-xl font-semibold">暂时无法访问企业信息</h1>
    <p className="text-sm text-slate-600">请确认使用此企业的有效账号登录。成员管理和用量报表需要企业管理员权限，额度池明细需要企业负责人权限；也可以稍后重试。</p>
    <button onClick={reset} className="rounded-lg border px-4 py-2">重试</button>
    <Link href="/account/login" className="ml-4 underline">切换登录账号</Link>
  </section>;
}
