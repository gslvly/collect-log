# collect-log

前端主动上报的动态数据采集系统 —— 设计文档。

管理员在后台创建「数据采集表」并配置字段，系统生成公开 `tableId` 与上报密钥；业务前端按签名协议主动调用上传接口，一次上报在 ClickHouse 中写入一行；后台按时间与业务字段做筛选、分组与统计。

不是自动采集行为的埋点 SDK，也不是可反复编辑的表单系统。

## 技术栈

- 前端：Vite + Vue 3 + TypeScript + Element Plus + ECharts
- 后端：Node.js LTS + TypeScript + Fastify
- 存储：ClickHouse（同时存放账户、元数据与采集数据）

## 文档

完整设计见 [DESIGN.md](./DESIGN.md)。

