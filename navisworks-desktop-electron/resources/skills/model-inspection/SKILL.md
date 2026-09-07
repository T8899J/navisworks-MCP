---
name: model-inspection
description: 检查当前 Navisworks 文档、当前选择、保存视点和模型基本结构。
---

# Model Inspection

用于快速摸清一个 Navisworks 模型的当前状态。

1. 需要"当前选择""现在打开了什么"这类**实时**信息时，必须调用对应只读工具重新获取：
   - 当前选择：`navisworks_get_selection`（不要把历史选择当成当前选择）。
   - 文档与单位：`navisworks_get_document`。
   - 保存视点：`navisworks_list_viewpoints`。
2. 先做小范围探查：用 `navisworks_find_items` 带 `limit` 和过滤条件，不要一次性展开整个模型。
3. 结果过大被外部化时，用 `read_tool_result` 分页读取，不要臆测未读到的内容。
4. 只有在用户明确要求改变画面时，才使用会改动画面的工具（选择、可见性、视点激活），并接受审批。
