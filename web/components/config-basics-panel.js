import { Field, SubmitButton, TextAreaField } from "./admin-forms";
import { updateSettingsAction } from "../app/admin/actions";

function HiddenTrialDays({ value }) {
  return <input type="hidden" name="licenseTrialDays" value={Number(value ?? 3)} />;
}

function SectionShell({ title, description, children }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-xl font-semibold text-slate-950">{title}</h2>
      {description ? <p className="mt-2 max-w-2xl text-sm text-slate-500">{description}</p> : null}
      {children}
    </section>
  );
}

export function ConfigDeliveryPanel({ settings, t }) {
  const delivery = t.admin.settingsDelivery;
  const s = t.admin.settings;

  return (
    <SectionShell title={s.trialTitle} description={s.trialDesc}>
      <form action={updateSettingsAction} className="mt-6 grid gap-5 lg:grid-cols-2">
        <input type="hidden" name="settingsSection" value="delivery" />
        <div className="lg:col-span-2 max-w-sm">
          <Field label={s.trialDays} name="licenseTrialDays" type="number" defaultValue={settings.licenseTrialDays ?? 3} required />
        </div>
        <div className="lg:col-span-2 max-w-md">
          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-slate-800">{delivery.modelTitle}</span>
            <select
              name="modelDeliveryMode"
              defaultValue={settings.modelDeliveryMode || "direct"}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-4 focus:ring-brand/10"
            >
              <option value="direct">{delivery.direct}</option>
              <option value="gateway">{delivery.gateway}</option>
            </select>
            <span className="mt-1 block text-xs text-slate-500">{delivery.modelHelp}</span>
          </label>
        </div>
        <div className="lg:col-span-2 max-w-md">
          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-slate-800">{delivery.mediaTitle}</span>
            <select
              name="mediaDeliveryMode"
              defaultValue={settings.mediaDeliveryMode || "direct"}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-4 focus:ring-brand/10"
            >
              <option value="direct">{delivery.direct}</option>
              <option value="gateway">{delivery.gateway}</option>
            </select>
            <span className="mt-1 block text-xs text-slate-500">{delivery.mediaHelp}</span>
          </label>
        </div>
        <div className="flex items-end">
          <SubmitButton>{s.save}</SubmitButton>
        </div>
      </form>
    </SectionShell>
  );
}

export function QiniuSettingsPanel({ settings, t }) {
  const qiniu = settings.qiniu || {};
  const s = t.admin.settings;

  return (
    <SectionShell title={s.qiniuTitle} description={s.qiniuDesc}>
      <form action={updateSettingsAction} className="mt-6 grid gap-5 lg:grid-cols-2">
        <input type="hidden" name="settingsSection" value="qiniu" />
        <HiddenTrialDays value={settings.licenseTrialDays} />
        <Field label={s.qiniuPublicBaseUrl} name="qiniuPublicBaseUrl" defaultValue={qiniu.publicBaseUrl || ""} required />
        <Field label={s.qiniuUploadUrl} name="qiniuUploadUrl" defaultValue={qiniu.uploadUrl || "https://upload.qiniup.com"} required />
        <Field label={s.qiniuAccessKey} name="qiniuAccessKey" defaultValue={qiniu.accessKey || ""} required />
        <Field label={s.qiniuBucket} name="qiniuBucket" defaultValue={qiniu.bucket || ""} required />
        <Field
          label={qiniu.hasSecretKey ? s.qiniuSecretKeyKeep : s.qiniuSecretKey}
          name="qiniuSecretKey"
          type="password"
          placeholder={qiniu.hasSecretKey ? s.qiniuSecretKeyPlaceholder : ""}
          required={!qiniu.hasSecretKey}
        />
        <div className="flex items-end">
          <SubmitButton>{s.save}</SubmitButton>
        </div>
      </form>
    </SectionShell>
  );
}

export function SmsSettingsPanel({ settings, t }) {
  const aliyunSms = settings.aliyunSms || {};
  const s = t.admin.settings;

  return (
    <SectionShell title={s.aliyunSmsTitle || "阿里云短信"} description={s.aliyunSmsDesc || "用于手机号验证码登录。密钥加密存储在服务端数据库，不会下发给客户端。"}>
      <form action={updateSettingsAction} className="mt-6 grid gap-5 lg:grid-cols-2">
        <input type="hidden" name="settingsSection" value="sms" />
        <HiddenTrialDays value={settings.licenseTrialDays} />
        <Field label={s.aliyunSmsAccessKeyId || "AccessKeyId"} name="aliyunSmsAccessKeyId" defaultValue={aliyunSms.accessKeyId || ""} required />
        <Field label={s.aliyunSmsRegion || "Region"} name="aliyunSmsRegion" defaultValue={aliyunSms.region || "cn-hangzhou"} required />
        <Field label={s.aliyunSmsSignName || "短信签名"} name="aliyunSmsSignName" defaultValue={aliyunSms.signName || ""} required />
        <Field label={s.aliyunSmsTemplateLogin || "登录模板 Code"} name="aliyunSmsTemplateLogin" defaultValue={aliyunSms.templateLogin || ""} required />
        <Field
          label={aliyunSms.hasAccessKeySecret ? (s.aliyunSmsAccessKeySecretKeep || "AccessKeySecret（已配置）") : (s.aliyunSmsAccessKeySecret || "AccessKeySecret")}
          name="aliyunSmsAccessKeySecret"
          type="password"
          placeholder={aliyunSms.hasAccessKeySecret ? (s.aliyunSmsSecretPlaceholder || "留空表示不修改") : ""}
          required={!aliyunSms.hasAccessKeySecret}
        />
        <div className="flex items-end">
          <SubmitButton>{s.save}</SubmitButton>
        </div>
      </form>
    </SectionShell>
  );
}

export function PaymentSettingsPanel({ settings, t }) {
  const payment = settings.payment || {};
  const alipay = payment.alipay || {};
  const wechat = payment.wechat || {};
  const s = t.admin.settings;

  return (
    <SectionShell title={s.paymentTitle || "支付配置"} description={s.paymentDesc || "配置官网购买使用的支付方式。密钥加密存储在服务端数据库，不会下发给客户端。"}>
      <form action={updateSettingsAction} className="mt-6 grid gap-5 lg:grid-cols-2">
        <input type="hidden" name="settingsSection" value="payment" />
        <HiddenTrialDays value={settings.licenseTrialDays} />
        <label className="lg:col-span-2 flex items-center gap-2 text-sm text-slate-700">
          <input className="h-4 w-4 rounded border-slate-300 text-brand" name="paymentFakePaymentsEnabled" type="checkbox" defaultChecked={Boolean(payment.fakePaymentsEnabled)} />
          {s.paymentFakePaymentsEnabled || "启用模拟支付"}
        </label>

        <div className="lg:col-span-2 rounded-xl border border-slate-200 p-4">
          <label className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-800">
            <input className="h-4 w-4 rounded border-slate-300 text-brand" name="alipayEnabled" type="checkbox" defaultChecked={Boolean(alipay.enabled)} />
            {s.alipayTitle || "支付宝"}
          </label>
          <div className="grid gap-5 lg:grid-cols-2">
            <Field label={s.alipayAppId || "AppId"} name="alipayAppId" defaultValue={alipay.appId || ""} />
            <Field label={s.alipayMerchantId || "商户号 / SellerId"} name="alipayMerchantId" defaultValue={alipay.merchantId || ""} />
            <Field label={s.alipayNotifyUrl || "异步通知 URL"} name="alipayNotifyUrl" defaultValue={alipay.notifyUrl || ""} />
            <Field label={s.alipayReturnUrl || "同步返回 URL"} name="alipayReturnUrl" defaultValue={alipay.returnUrl || ""} />
            <TextAreaField label={s.alipayPublicKey || "支付宝公钥"} name="alipayPublicKey" defaultValue={alipay.publicKey || ""} rows={4} />
            <TextAreaField
              label={alipay.hasPrivateKey ? (s.alipayPrivateKeyKeep || "应用私钥（已配置）") : (s.alipayPrivateKey || "应用私钥")}
              name="alipayPrivateKey"
              placeholder={alipay.hasPrivateKey ? (s.paymentSecretPlaceholder || "留空表示不修改") : ""}
              rows={4}
            />
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input className="h-4 w-4 rounded border-slate-300 text-brand" name="alipaySandbox" type="checkbox" defaultChecked={Boolean(alipay.sandbox)} />
              {s.paymentSandbox || "沙箱模式"}
            </label>
          </div>
        </div>

        <div className="lg:col-span-2 rounded-xl border border-slate-200 p-4">
          <label className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-800">
            <input className="h-4 w-4 rounded border-slate-300 text-brand" name="wechatEnabled" type="checkbox" defaultChecked={Boolean(wechat.enabled)} />
            {s.wechatTitle || "微信支付"}
          </label>
          <div className="grid gap-5 lg:grid-cols-2">
            <Field label={s.wechatAppId || "AppId"} name="wechatAppId" defaultValue={wechat.appId || ""} />
            <Field label={s.wechatMchId || "商户号 MchId"} name="wechatMchId" defaultValue={wechat.mchId || ""} />
            <Field label={s.wechatCertSerialNo || "商户证书序列号"} name="wechatCertSerialNo" defaultValue={wechat.certSerialNo || ""} />
            <Field label={s.wechatNotifyUrl || "支付通知 URL"} name="wechatNotifyUrl" defaultValue={wechat.notifyUrl || ""} />
            <Field
              label={wechat.hasApiV3Key ? (s.wechatApiV3KeyKeep || "API v3 Key（已配置）") : (s.wechatApiV3Key || "API v3 Key")}
              name="wechatApiV3Key"
              type="password"
              placeholder={wechat.hasApiV3Key ? (s.paymentSecretPlaceholder || "留空表示不修改") : ""}
            />
            <TextAreaField
              label={wechat.hasPrivateKey ? (s.wechatPrivateKeyKeep || "商户私钥（已配置）") : (s.wechatPrivateKey || "商户私钥")}
              name="wechatPrivateKey"
              placeholder={wechat.hasPrivateKey ? (s.paymentSecretPlaceholder || "留空表示不修改") : ""}
              rows={4}
            />
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input className="h-4 w-4 rounded border-slate-300 text-brand" name="wechatSandbox" type="checkbox" defaultChecked={Boolean(wechat.sandbox)} />
              {s.paymentSandbox || "沙箱模式"}
            </label>
          </div>
        </div>
        <div className="flex items-end">
          <SubmitButton>{s.save}</SubmitButton>
        </div>
      </form>
    </SectionShell>
  );
}

export function ConfigBasicsPanel(props) {
  return <ConfigDeliveryPanel {...props} />;
}
