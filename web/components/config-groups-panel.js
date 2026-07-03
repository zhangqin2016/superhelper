"use client";

import { useActionState } from "react";
import {
  assignConfigGroupAction,
  createConfigGroupAction,
  deleteConfigGroupAction,
} from "../app/admin/actions";
import { SubmitButton } from "./admin-forms";
import { useI18n } from "../lib/use-i18n";

const labels = {
  zh: {
    title: "设备组",
    desc: "建立设备组后,把设备或授权放进组里;再用上面的「配置」表单为该组(scope=设备组)下发模型。组内成员会继承组的配置。",
    createTitle: "新建 / 更新设备组",
    assignTitle: "把成员放进组",
    id: "组 ID",
    name: "组名称",
    kind: "成员类型",
    kindDevice: "设备",
    kindLicense: "授权(整客户)",
    targetId: "设备 ID / 授权 ID",
    group: "目标组",
    clear: "(移出所有组)",
    save: "保存",
    assign: "归组",
    members: "成员",
    devices: "设备",
    licenses: "授权",
    remove: "删除",
    empty: "还没有设备组。",
  },
  en: {
    title: "Device groups",
    desc: "Create a group, put devices or licenses into it, then use the form above with scope=device group to deliver a model to everyone in it. Members inherit the group's config.",
    createTitle: "Create / update a group",
    assignTitle: "Put a member into a group",
    id: "Group ID",
    name: "Group name",
    kind: "Member type",
    kindDevice: "Device",
    kindLicense: "License (whole customer)",
    targetId: "Device ID / License ID",
    group: "Target group",
    clear: "(remove from any group)",
    save: "Save",
    assign: "Assign",
    members: "Members",
    devices: "devices",
    licenses: "licenses",
    remove: "Delete",
    empty: "No device groups yet.",
  },
  ar: {
    title: "مجموعات الفئات",
    desc: "أنشئ مجموعة، ثم أضف أجهزة أو تراخيص إليها، واستخدم النموذج أعلاه مع النطاق=مجموعة فئة لإرسال نموذج للجميع. يرث الأعضاء إعداد المجموعة.",
    createTitle: "إنشاء / تحديث مجموعة",
    assignTitle: "إضافة عضو إلى مجموعة",
    id: "معرّف المجموعة",
    name: "اسم المجموعة",
    kind: "نوع العضو",
    kindDevice: "جهاز",
    kindLicense: "ترخيص (عميل كامل)",
    targetId: "معرّف الجهاز / الترخيص",
    group: "المجموعة الهدف",
    clear: "(إزالة من أي مجموعة)",
    save: "حفظ",
    assign: "تعيين",
    members: "الأعضاء",
    devices: "أجهزة",
    licenses: "تراخيص",
    remove: "حذف",
    empty: "لا توجد مجموعات بعد.",
  },
};

const initialState = { ok: null, message: "" };

function fieldClass() {
  return "w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-brand focus:ring-4 focus:ring-brand/10";
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-semibold text-slate-800">{label}</span>
      {children}
    </label>
  );
}

export function ConfigGroupsPanel({ groups = [], showCreate = true, showAssign = true, showList = true }) {
  const { locale } = useI18n();
  const copy = labels[locale] || labels.zh;
  const [createState, createAction, creating] = useActionState(createConfigGroupAction, initialState);
  const [assignState, assignAction, assigning] = useActionState(assignConfigGroupAction, initialState);

  return (
    <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
      <div className="border-b border-slate-100 pb-4">
        <h2 className="text-2xl font-semibold text-slate-950">{copy.title}</h2>
        <p className="mt-1 max-w-4xl text-sm text-slate-500">{copy.desc}</p>
      </div>

      {(showCreate || showAssign) ? <div className="mt-5 grid gap-5 lg:grid-cols-2">
        {showCreate ? <form action={createAction} className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
          <h3 className="text-base font-semibold text-slate-900">{copy.createTitle}</h3>
          <Field label={copy.id}>
            <input className={fieldClass()} name="id" required placeholder="vip" />
          </Field>
          <Field label={copy.name}>
            <input className={fieldClass()} name="name" required placeholder="VIP" />
          </Field>
          <SubmitButton disabled={creating}>{creating ? "..." : copy.save}</SubmitButton>
          {createState?.message ? (
            <p className={`text-sm ${createState.ok ? "text-emerald-700" : "text-red-700"}`}>{createState.message}</p>
          ) : null}
        </form> : null}

        {showAssign ? <form action={assignAction} className="space-y-3 rounded-2xl border border-slate-200 p-4">
          <h3 className="text-base font-semibold text-slate-900">{copy.assignTitle}</h3>
          <Field label={copy.kind}>
            <select className={fieldClass()} name="kind" defaultValue="device">
              <option value="device">{copy.kindDevice}</option>
              <option value="license">{copy.kindLicense}</option>
            </select>
          </Field>
          <Field label={copy.targetId}>
            <input className={fieldClass()} name="targetId" required />
          </Field>
          <Field label={copy.group}>
            <select className={fieldClass()} name="groupId" defaultValue="">
              <option value="">{copy.clear}</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name} ({group.id})
                </option>
              ))}
            </select>
          </Field>
          <SubmitButton disabled={assigning}>{assigning ? "..." : copy.assign}</SubmitButton>
          {assignState?.message ? (
            <p className={`text-sm ${assignState.ok ? "text-emerald-700" : "text-red-700"}`}>{assignState.message}</p>
          ) : null}
        </form> : null}
      </div> : null}

      {showList ? <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
        {groups.length ? (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-start text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2 text-start">{copy.id}</th>
                <th className="px-4 py-2 text-start">{copy.name}</th>
                <th className="px-4 py-2 text-start">{copy.members}</th>
                <th className="px-4 py-2 text-end" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {groups.map((group) => (
                <tr key={group.id}>
                  <td className="px-4 py-2 font-mono text-xs text-slate-600">{group.id}</td>
                  <td className="px-4 py-2 font-semibold text-slate-900">{group.name}</td>
                  <td className="px-4 py-2 text-slate-600">
                    {group.deviceCount || 0} {copy.devices} · {group.licenseCount || 0} {copy.licenses}
                  </td>
                  <td className="px-4 py-2 text-end">
                    <form action={deleteConfigGroupAction}>
                      <input type="hidden" name="id" value={group.id} />
                      <button type="submit" className="text-xs font-semibold text-red-600 hover:underline">
                        {copy.remove}
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="px-4 py-6 text-center text-sm text-slate-400">{copy.empty}</p>
        )}
      </div> : null}
    </section>
  );
}
