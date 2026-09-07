---
name: property-analysis
description: 搜索构件并批量读取、比较和总结 Navisworks 属性。
---

# Property Analysis

用于批量查询、比较、汇总构件属性。

1. 先明确范围：整模型 / 当前选择 / 某类别 / 某关键字。范围不清时**先问用户**，不要猜。
2. 用 `navisworks_find_items` 取得目标集合（带过滤与 `limit`）；结果被截断时按提示续扫或改用 `read_tool_result`。
3. 只查询**真正需要**的属性：`navisworks_get_item_properties` 传必要的 `itemIds` 与 `category`/`property`，不要读取无关属性。
4. 大结果保持 bounded：分段读取、逐步汇总，不要把完整大 JSON 塞进推理。
5. 输出结论时给出关键数值与出处；数据没读到就如实说明，不要编造。
