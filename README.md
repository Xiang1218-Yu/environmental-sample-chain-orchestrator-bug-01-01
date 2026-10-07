# Environmental Sample Chain Orchestrator

一个从 0-1 构建的环境样本链路编排项目基线，用来管理采样、容器封签、跨机构交接、实验室接收、分装、实验批次、仪器结果修订、质量复核和证据包导出。

## 当前实现

- `src/domain/types.ts`：领域对象、状态和同步模型
- `src/store/store.ts`：内存 Store、全局 ID、审计、Outbox 和事务快照回滚
- `src/services/sampling-service.ts`：采样记录与封存容器
- `src/services/custody-service.ts`：交出、接收、封签和温度轨迹
- `src/services/receiving-service.ts`：实验室接收、接受/隔离/拒收
- `src/services/aliquot-service.ts`：批量分装、单位换算、容量扣减和幂等操作
- `src/services/batch-service.ts`：实验批次成员、协议冻结和运行生命周期
- `src/services/result-service.ts`：仪器运行、外部运行号幂等和结果 revision
- `src/services/quality-service.ts`：质量结论、质控门槛和批次批准
- `src/services/evidence-service.ts`：一致性证据包、清单哈希和冻结
- `src/services/sync-service.ts`：离线 Envelope、客户端序列、payload 冲突和重放
- `src/services/sync-protocol.ts`：canonical JSON、内容哈希校验、作用域幂等键
- `src/domain/ids.ts`：确定性哈希 ID
- `src/demo/smoke.ts`：一条可运行的端到端样例

## 同步协议（离线录入 / 网关重试）

- **作用域幂等键**：`tenantId|projectId|deviceId|operationId`。设备移交到其他项目后复用操作号不会串项目；跨项目同号各自独立成功。
- **内容哈希**：`payloadHash = sha256(type + canonicalJson(payload))` 的前 16 位，canonical JSON 递归排序对象键。网关收到 Envelope 后重算哈希，哈希不符直接拒绝且不占用幂等键。
- **稳定结果**：同内容重试永远返回相同 `resultReference`：首次 `APPLIED`，之后 `DUPLICATE`；同 operationId 不同内容返回**稳定** `CONFLICT`（持久化、可重复查询），永不静默跳过，也不改写已生效的内容。
- **中途失败安全**：执行副作用前先落 `APPLYING` 主张；模拟进程崩溃（事务不回滚）后，同内容重试走补偿路径——补齐缺失的容器、容器状态、温度记录、容量扣减、audit/outbox，全部只执行一次。可重试前提失败（依赖未到、状态未就绪、持有人不符）不产生任何决定；同项目重复物理条码等真实冲突落 `CONFLICT`。
- **乱序补传**：序列只用于设备内排序，不再有 STALE 窗口；依赖未就绪的包可随后原样重发成功。
- **确定性 ID**：样本/容器/交接/接收/分装 ID 均由作用域键哈希派生，重放引用稳定，不产生重复实体。

## 测试

```bash
npm test
```

覆盖：两台设备并发录入、批量上传中断恢复、乱序/逆序补传、跨项目同号、重复请求（同内容/异内容/篡改哈希）、四类操作中途崩溃补偿、并发重复投递。

## 运行

```bash
npm install
npm run build
npm run smoke
```

当前源码是**干净基线**，没有为了出题主动埋入 Bug。后续应先在这份基线上补充测试和复现证据，再从真实缺陷中生成 Bug 题目。
