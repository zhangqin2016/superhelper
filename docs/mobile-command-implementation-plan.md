# Lily Mobile Command Pro 实施计划

## 执行摘要

本计划基于现有规范文档，描述 Mobile Command Pro 的完整方向。当前已完成的是 Phase 1 web demo core；完整的移动端观察/控制桌面端功能和语音 ASR 仍属于后续 Phase 2/生产证据范围。

**目标**：
- ✅ Phase 1 web demo：扫码免登录配对、桌面批准、手机发任务/图片、回复投影、中断、历史、配对管理
- ✅ Server-local v1：聊天级远程会话、文件上传、产物描述/下载令牌、能力元数据
- 🔶 移动端语音输入（ASR provider/privacy/evidence 未放行）
- 🔶 移动端观察桌面屏幕（Windows + macOS 证据未放行）
- 🔶 移动端控制桌面操作（鼠标/键盘输入，OS 权限和隐私证据未放行）
- 🔶 大文件/后台上传到桌面端 Agent（demo 仅有 server-local v1；生产存储、隐私、重试证据未放行）

**当前状态**：Phase 1 web demo core 已可用；生产远控和原生能力仍阻塞。当前 demo 状态见 [Mobile Command Current Demo Status](mobile-command-current-demo-status.md)。

---

## 第一阶段：核心基础设施

### 1.1 服务器端身份与配对

**文件**：`server/src/routes/public/mobile-pairing.js`

```javascript
// 配对流程
POST /api/mobile/pairing/start     // 桌面端发起，生成 QR token
POST /api/mobile/pairing/consume   // 移动端扫码后消费 token
```

**依赖**：
- MC-ADR-003（已接受）- 身份映射
- MC-ADR-013（已接受）- 路由注册

### 1.2 远程会话管理

**文件**：`server/src/routes/public/mobile-command-surface.js`, `server/src/services/mobile-command-remote-session.js`

```javascript
// 会话管理
POST /api/mobile/sessions                      // 创建远程会话
POST /api/mobile/sessions/{id}/refresh         // 刷新 token
DELETE /api/mobile/sessions/{id}               // 结束会话
POST /api/mobile/sessions/{id}/permissions     // 请求权限提升
POST /api/mobile/sessions/{id}/turn-credentials // 获取 TURN 凭证
```

当前实现状态：`POST /api/mobile/sessions`、`refresh`、`DELETE` 已实现 server-local chat-level v1；权限提升和 TURN 凭证仍返回证据门控的 typed disabled response。

### 1.3 文件上传服务

**文件**：`server/src/routes/public/mobile-command-surface.js`, `server/src/services/mobile-command-file-transfer.js`

```javascript
// 分片上传
POST /api/mobile/uploads                       // 创建上传记录
PUT /api/mobile/uploads/{id}/chunks/{index}    // 上传分片
POST /api/mobile/uploads/{id}/complete         // 完成上传
GET /api/mobile/uploads/{id}                   // 查询状态
```

当前实现状态：server-local v1 已支持上传创建、分片、完成、状态、产物描述和短期 `mobile-artifact://` 下载令牌；生产对象存储、后台上传和桌面 staging 仍需要证据放行。

---

## 第二阶段：桌面端核心模块

### 2.1 屏幕捕获服务

**文件**：`src/main/screen-capture.js`

#### macOS 实现

```javascript
const { screen, desktopCapturer } = require('electron');

class ScreenCaptureService {
  async getSources() {
    // 使用 desktopCapturer 获取可用源
    const sources = await desktopCapturer.getSources({
      modes: [ { contentHint: 'screen' } ],
      thumbnailSize: { width: 320, height: 240 }
    });
    
    return sources.map(source => ({
      id: source.id,
      name: source.name,
      type: source.id.startsWith('screen:') ? 'desktop' : 'app',
      thumbnail: source.thumbnail.toDataURL()
    }));
  }
  
  async startCapture(sourceId) {
    // 使用 webContents 的 getDisplayMedia API
    // 或通过 ScreenCaptureKit helper 实现高性能捕获
  }
}
```

#### Windows 实现

```javascript
// Windows 优先使用 desktopCapturer
// 如需更高性能，可考虑 Windows Graphics Capture helper
```

### 2.2 输入注入服务

**文件**：`src/main/input-injector.js`

#### Windows 实现（SendInput Helper）

```javascript
const { spawn } = require('child_process');
const path = require('path');

class WindowsInputInjector {
  constructor() {
    // Helper 二进制文件从 resources 加载
    this.helperPath = path.join(
      process.resourcesPath,
      'helpers',
      'windows-input-helper.exe'
    );
    this.helper = null;
    this.commandQueue = [];
  }
  
  async start() {
    // 启动 helper 进程，通过 stdin 接收 JSON 命令
    this.helper = spawn(this.helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    this.helper.stdin.on('data', this.handleResponse.bind(this));
  }
  
  async pointerMove(x, y, surfaceId) {
    // 发送归一化坐标到 helper
    const command = {
      type: 'move',
      x: x * this.surfaceWidth,
      y: y * this.surfaceHeight,
      requestId: this.generateRequestId()
    };
    
    this.helper.stdin.write(JSON.stringify(command) + '\n');
  }
  
  async pointerClick(button) {
    const command = {
      type: 'down',
      button,
      requestId: this.generateRequestId()
    };
    this.helper.stdin.write(JSON.stringify(command) + '\n');
  }
  
  async typeText(text) {
    const command = {
      type: 'typeText',
      text,
      requestId: this.generateRequestId()
    };
    this.helper.stdin.write(JSON.stringify(command) + '\n');
  }
}
```

**Windows Helper 代码**（Rust/C++）：

```rust
// windows-input-helper/src/main.rs
// 使用 Win32 SendInput API

use windows::Win32::UI::Input::SendInput;
use windows::Win32::UI::Input::KeyboardAndMouse::{INPUT, INPUT_0, INPUT_TYPE};

fn main() {
    let stdin = std::io::stdin();
    let mut line = String::new();
    
    while stdin.read_line(&mut line).is_ok() {
        let command: InputCommand = serde_json::from_str(line.trim()).unwrap();
        execute_command(command);
    }
}

fn execute_command(command: InputCommand) {
    match command.r#type {
        "move" => send_mouse_move(command.x, command.y),
        "down" => send_mouse_button(command.button, true),
        "up" => send_mouse_button(command.button, false),
        "typeText" => send_text(command.text),
        _ => {}
    }
}
```

#### macOS 实现（CGEvent Helper）

```swift
// macos-input-helper/InputMonitor.swift
import AppKit

class InputInjector {
    static let shared = InputInjector()
    
    func injectMouseMove(x: CGEventLocation, y: CGEventLocation) {
        let event = CGEvent(
            mouseEventSource: nil,
            mouseEventType: .mouseMoved,
            mouseLocation: CGPoint(x: x, y: y),
            mouseButton: .left
        )
        event?.post(tap: .cghidEventTap)
    }
    
    func injectKeyDown(key: String) {
        // 映射键名到 CGKeyCode
        let keyCode = CGKeyCode(key)
        let event = CGEvent(
            keyboardEventSource: nil,
            virtualKey: keyCode,
            keyState: .keyDown
        )
        event?.post(tap: .cghidEventTap)
    }
}
```

### 2.3 Agent 桥接服务

**文件**：`src/main/agent-bridge.js`

```javascript
const { TurnOrchestrator } = require('./turn-orchestrator');

class AgentBridge {
  async admitCommand(envelope) {
    // 1. 验证身份六元组
    const { 
      remoteSessionId, 
      mobileDeviceId, 
      desktopDeviceId,
      lilySessionId,
      text,
      idempotencyKey
    } = envelope;
    
    const valid = await this.validateIdentityTuple({
      remoteSessionId,
      mobileDeviceId,
      desktopDeviceId
    });
    
    if (!valid) {
      throw new Error('INVALID_IDENTITY');
    }
    
    // 2. 检查幂等性
    const existing = await this.checkIdempotency(idempotencyKey);
    if (existing) {
      return existing;
    }
    
    // 3. 通过 TurnOrchestrator 注入命令
    const result = await TurnOrchestrator.admitExternalCommand({
      sessionId: lilySessionId,
      text,
      source: 'mobile',
      commandId: envelope.commandId,
      requestedMode: envelope.mode,
      effectiveMode: 'queue' // 当前引擎降级为队列
    });
    
    // 4. 记录到持久化日志
    await this.ledger.record({
      commandId: envelope.commandId,
      idempotencyKey,
      state: 'admitted',
      effectiveMode: 'queue',
      createdAt: Date.now()
    });
    
    return result;
  }
}
```

### 2.4 事件投影服务

**文件**：`src/main/event-projector.js`

```javascript
class EventProjector {
  constructor() {
    this.journal = new ProjectionJournal();
    this.subscribers = new Map(); // remoteSessionId -> Set of callbacks
  }
  
  // 订阅远程会话的事件
  subscribe(remoteSessionId, callback) {
    if (!this.subscribers.has(remoteSessionId)) {
      this.subscribers.set(remoteSessionId, new Set());
    }
    this.subscribers.get(remoteSessionId).add(callback);
  }
  
  // 投影 TurnOrchestrator 事件到移动端
  async projectEvent(event) {
    const projected = this.redactEvent(event);
    
    // 追加到持久化日志
    await this.journal.append(projected);
    
    // 广播给订阅者
    for (const [sessionId, callbacks] of this.subscribers) {
      for (const callback of callbacks) {
        callback(projected);
      }
    }
  }
  
  // 红脱敏感信息
  redactEvent(event) {
    switch (event.type) {
      case 'assistant.delta':
        return {
          type: 'assistant.delta',
          delta: event.delta,
          assistantMessageId: event.assistantMessageId
        };
      
      case 'tool.started':
        return {
          type: 'tool.started',
          toolCallId: event.toolCallId,
          name: event.name,
          // 红脱 input 中的敏感信息
          summary: this.generateToolSummary(event.name)
        };
      
      case 'assistant.thinking.delta':
        // 禁止发送原始推理链
        return {
          type: 'reasoning.active',
          phase: 'thinking'
        };
      
      default:
        return event;
    }
  }
}
```

---

## 第三阶段：语音输入集成

### 3.1 阿里云 Dashscope ASR 适配器

**文件**：`src/renderer/modules/mobile/asr-adapter.js`

```javascript
import { dashscope } from '@alibabacloud/cache';

class DashscopeASRAdapter {
  constructor(apiKey) {
    this.client = new dashscope.Intelligence({
      apiKey
    });
    
    this.currentSession = null;
    this.partialTranscript = '';
    this.onTranscriptUpdate = null;
    this.onFinalTranscript = null;
  }
  
  async startListening() {
    // 使用 WebSocket 进行流式识别
    this.currentSession = await dashscope.aigc.genesis({
      model: 'paraformer-realtime-token',
      input: {
        messages: [{
          role: 'user',
          content: [{ type: 'audio', url: '' }]
        }]
      },
      parameters: {
        result_text: true,
        format: 'streaming'
      }
    });
  }
  
  async sendAudioChunk(audioData) {
    // audioData 是 ArrayBuffer 或 Base64
    const response = await this.currentSession.send(audioData);
    
    if (response.choices?.[0]?.delta?.content) {
      this.partialTranscript = response.choices[0].delta.content;
      this.onTranscriptUpdate?.({
        text: this.partialTranscript,
        isFinal: false,
        confidence: response.choices[0].logprobs?.confidence
      });
    }
  }
  
  async stopListening() {
    const finalResponse = await this.currentSession.close();
    
    if (finalResponse.choices?.[0]?.message?.content) {
      const finalText = finalResponse.choices[0].message.content;
      this.onFinalTranscript?.(finalText);
      this.partialTranscript = '';
    }
    
    this.currentSession = null;
  }
}
```

### 3.2 移动端语音组件

**文件**：`web/mobile-command/components/VoiceComposer.js`

```jsx
import React, { useState, useRef } from 'react';
import { DashscopeASRAdapter } from '../../services/asr-adapter';

export function VoiceComposer({ onSend }) {
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [mediaRecorder, setMediaRecorder] = useState(null);
  
  const asrRef = useRef(null);
  
  async function startRecording() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    
    // 初始化 ASR
    asrRef.current = new DashscopeASRAdapter(process.env.NEXT_PUBLIC_DASHSCOPE_API_KEY);
    
    asrRef.current.onTranscriptUpdate = ({ text, isFinal }) => {
      if (!isFinal) {
        setTranscript(text);
      }
    };
    
    asrRef.current.onFinalTranscript = (finalText) => {
      setTranscript(finalText);
    };
    
    recorder.ondataavailable = async (event) => {
      if (event.data.size > 0 && asrRef.current) {
        const arrayBuffer = await event.data.arrayBuffer();
        await asrRef.current.sendAudioChunk(arrayBuffer);
      }
    };
    
    recorder.start(100); // 每 100ms 发送一次
    setMediaRecorder(recorder);
    setIsRecording(true);
  }
  
  async function stopRecording() {
    if (mediaRecorder) {
      mediaRecorder.stop();
      mediaRecorder.stream.getTracks().forEach(track => track.stop());
    }
    
    if (asrRef.current) {
      await asrRef.current.stopListening();
    }
    
    setIsRecording(false);
  }
  
  function handleSend() {
    if (transcript.trim()) {
      onSend(transcript);
      setTranscript('');
    }
  }
  
  return (
    <div className="voice-composer">
      <textarea
        value={transcript}
        onChange={(e) => setTranscript(e.target.value)}
        placeholder="点击麦克风说话或输入文字..."
      />
      
      <div className="voice-actions">
        {isRecording ? (
          <button onClick={stopRecording} className="stop-btn">
            🛑 停止录音
          </button>
        ) : (
          <button onClick={startRecording} className="mic-btn">
            🎤 语音输入
          </button>
        )}
        
        {transcript && (
          <button onClick={handleSend} className="send-btn">
            ➤ 发送
          </button>
        )}
      </div>
    </div>
  );
}
```

---

## 第四阶段：移动端 Web 应用

### 4.1 项目结构

```
web/mobile-command/
├── pages/
│   ├── _app.js
│   ├── index.js              # 登录/设备列表
│   ├── pair.js               # 配对比对
│   └── session/
│       └── [sessionId].js    # 远程会话主页面
├── components/
│   ├── VoiceComposer.js      # 语音输入
│   ├── ScreenViewer.js       # 屏幕观察
│   ├── ControlPad.js         # 控制输入
│   └── FileUploader.js       # 文件上传
├── services/
│   ├── websocket.js          # WebSocket 连接
│   ├── asr-adapter.js        # ASR 适配器
│   ├── webrtc.js             # WebRTC 管理
│   └── api.js                # HTTP API 客户端
└── styles/
    └── globals.css
```

### 4.2 屏幕观察组件

```jsx
// web/mobile-command/components/ScreenViewer.js
import React, { useRef, useEffect } from 'react';

export function ScreenViewer({ peerConnection }) {
  const videoRef = useRef(null);
  
  useEffect(() => {
    if (peerConnection && videoRef.current) {
      peerConnection.ontrack = (event) => {
        if (event.streams[0]) {
          videoRef.current.srcObject = event.streams[0];
        }
      };
    }
  }, [peerConnection]);
  
  return (
    <video 
      ref={videoRef} 
      autoPlay 
      playsInline
      className="screen-viewer"
    />
  );
}
```

### 4.3 控制输入组件

```jsx
// web/mobile-command/components/ControlPad.js
import React, { useState } from 'react';

export function ControlPad({ dataChannel }) {
  const [lastPosition, setLastPosition] = useState({ x: 0, y: 0 });
  
  function handlePointerMove(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width; // 0..1
    const y = (e.clientY - rect.top) / rect.height; // 0..1
    
    if (dataChannel?.readyState === 'open') {
      dataChannel.send({
        type: 'control.pointer.move',
        payload: {
          surfaceId: 'active',
          x,
          y,
          pointerType: 'touch'
        }
      });
    }
    
    setLastPosition({ x, y });
  }
  
  function handlePointerDown(e) {
    if (dataChannel?.readyState === 'open') {
      dataChannel.send({
        type: 'control.pointer.down',
        payload: {
          surfaceId: 'active',
          x: lastPosition.x,
          y: lastPosition.y,
          button: 'left',
          pointerType: 'touch'
        }
      });
    }
  }
  
  function handlePointerUp() {
    if (dataChannel?.readyState === 'open') {
      dataChannel.send({
        type: 'control.pointer.up',
        payload: {
          surfaceId: 'active',
          x: lastPosition.x,
          y: lastPosition.y,
          button: 'left',
          pointerType: 'touch'
        }
      });
    }
  }
  
  return (
    <div 
      className="control-pad"
      onPointerMove={handlePointerMove}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
    >
      <div className="control-hint">触摸拖动控制鼠标</div>
    </div>
  );
}
```

---

## 第五阶段：权限与安全

### 5.1 权限策略

**文件**：`src/main/permission-policy.js`

```javascript
class PermissionPolicy {
  constructor(remoteSession) {
    this.session = remoteSession;
    this.currentLevel = PermissionLevel.ChatOnly;
  }
  
  canPerform(action) {
    const policy = PERMISSION_MATRIX[action];
    
    if (!policy) {
      return { allowed: false, reason: 'UNKNOWN_ACTION' };
    }
    
    if (this.currentLevel >= policy.minLevel) {
      return { allowed: true };
    }
    
    if (policy.requiresApproval) {
      return { 
        allowed: false, 
        reason: 'APPROVAL_REQUIRED',
        approvalType: policy.approvalType
      };
    }
    
    return { allowed: false, reason: 'INSUFFICIENT_PERMISSION' };
  }
  
  async requestPermission(level, reason) {
    // 创建审批请求
    const approval = await ApprovalService.create({
      remoteSessionId: this.session.id,
      requestedLevel: level,
      reason,
      expiresAt: Date.now() + 10 * 60 * 1000 // 10 分钟
    });
    
    // 等待桌面端审批
    const result = await approval.waitForDecision();
    
    if (result.granted) {
      this.currentLevel = level;
    }
    
    return result;
  }
}

const PERMISSION_MATRIX = {
  'agent.message': { minLevel: PermissionLevel.ChatOnly },
  'screen.subscribe.app': { minLevel: PermissionLevel.ObserveApp, requiresApproval: true },
  'screen.subscribe.desktop': { minLevel: PermissionLevel.ObserveDesktop, requiresApproval: true },
  'input.pointer': { minLevel: PermissionLevel.ControlApp },
  'input.keyboard': { minLevel: PermissionLevel.ControlApp },
  'clipboard.read': { minLevel: PermissionLevel.ChatOnly, requiresApproval: true, approvalType: 'clipboard_read' },
  'clipboard.write': { minLevel: PermissionLevel.ControlApp }
};
```

---

## 实施检查清单

### 服务器端
- [x] 数据库迁移 - 添加 mobile_pairing_challenges 表
- [x] 数据库迁移 - 添加 mobile_pairing_grants 表
- [ ] 数据库迁移 - 添加 mobile_remote_sessions 表（生产持久化未放行；demo 为 server-local v1）
- [ ] 数据库迁移 - 添加 mobile_approvals 表（生产审批流未放行）
- [ ] 数据库迁移 - 添加 mobile_uploads 表（生产对象存储/持久化未放行；demo 为 server-local v1）
- [x] 实现配对路由
- [x] 实现会话路由（server-local chat-level v1）
- [x] 实现上传路由（server-local v1）
- [ ] 实现 TURN 凭证路由（证据门控 typed disabled）

### 桌面端
- [ ] 实现屏幕捕获服务
- [ ] 实现 Windows 输入注入 helper
- [ ] 实现 macOS 输入注入 helper
- [x] 实现 Agent 桥接（文本/图片命令 demo 路径）
- [x] 实现事件投影（demo 回复/历史/状态投影）
- [ ] 实现权限策略
- [ ] 实现审批服务
- [ ] 实现 WebRTC 信令
- [ ] 实现 DataChannel 协议

### 移动端
- [x] 初始化 Next.js 项目
- [x] 实现免登录配对页面
- [ ] 实现语音输入组件
- [ ] 实现屏幕观察组件
- [ ] 实现控制输入组件
- [x] 实现图片附件组件
- [x] 实现 WebSocket/relay 连接管理（demo 路径）
- [ ] 实现 WebRTC 连接管理

### 测试
- [x] 配对流程测试
- [x] 会话管理测试（server-local chat-level v1）
- [ ] 语音识别测试
- [ ] 屏幕捕获测试
- [ ] 输入注入测试
- [ ] 权限审批测试
- [x] 文件上传测试（server-local v1）

---

## 已知风险与限制

### macOS 限制
1. **屏幕捕获权限**：需要用户在系统偏好设置中授予"屏幕录制"权限
2. **输入注入权限**：需要用户在系统偏好设置中授予"辅助功能"权限
3. **签名与公证**：Helper 进程需要与主应用一起签名和公证

### Windows 限制
1. **UAC 提升**：某些操作可能需要管理员权限
2. **DPI 缩放**：需要正确处理高 DPI 显示器的坐标映射

### 通用限制
1. **网络 NAT**：需要 TURN 服务器穿透 NAT
2. **延迟**：WebRTC 延迟影响控制体验
3. **电池**：持续屏幕捕获和 WebRTC 消耗较多电量

---

## 下一步行动

1. **确认 ASR API 详情**：获取阿里云 Dashscope API Key 和具体接口文档
2. **准备开发环境**：
   - Windows 开发机（用于测试 Windows helper）
   - macOS 开发机 + Xcode（用于构建 macOS helper）
3. **搭建 TURN 服务器**：选择 Twilio 或自建 coturn
4. **实施优先级**：
   - P0: 基础配对 + 聊天消息
   - P1: 屏幕观察
   - P2: 语音输入
   - P3: 控制输入
   - P4: 文件上传

---

## 参考文档

- `mobile-command-auth-identity-contract.md` - 身份认证
- `mobile-command-agent-bridge-contract.md` - Agent 桥接
- `mobile-command-desktop-os-adapters.md` - 桌面适配器
- `mobile-command-voice-input.md` - 语音输入
- `mobile-command-permission-threat-model.md` - 权限模型
- `mobile-command-state-machines.md` - 状态机
