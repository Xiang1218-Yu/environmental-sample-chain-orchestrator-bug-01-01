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
- `src/demo/smoke.ts`：一条可运行的端到端样例
- `test/sync-service.test.ts`：同步幂等与冲突回归测试（两台设备、批量中断、乱序补传、跨项目同号、重复请求）

## 运行

```bash
npm install
npm run build
npm run smoke
npm test
```

## 同步流程的幂等约定

- 幂等键为 `tenantId|projectId|deviceId|operationId`：设备跨项目交接复用时，不同项目的同号操作各自独立应用。
- 同内容重试返回首次应用的稳定结果；同操作号不同内容返回 `CONFLICT` 并单独留痕，不污染原始记录。
- 派发与登记在同一事务内完成：中途失败整体回滚、不留同步记录，客户端修正后可安全重试，不会出现"已登记但未完成"的假成功。
- 样本按 `tenantId|projectId|deviceId|clientSequence` 去重并校验内容；容器条码在租户内唯一（一个物理容器只对应一个样本）；客户端预分配样本号冲突时拒绝覆盖，避免孤立容器。
