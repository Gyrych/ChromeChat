# 🏆 Real-world One-shot LLM Coding Leaderboard  

大模型编程真实场景“一次成功率”榜单 | Real-world leaderboard for **one-shot success rate** in coding tasks.  

---

## 📖 关于这个仓库 | About This Repo  

现有的大模型评测，多数依赖平均分或离线数据集，难以体现真实开发场景下的表现。  
本仓库专注于 **一次性成功率（One-shot Success Rate）**，即模型在真实编程任务中，能否 **一次生成即可运行/编译/通过测试**。  

Unlike synthetic benchmarks, this project focuses on **real-world coding scenarios** where users need **working results on the first try**.  
This reflects the actual experience of developers paying for API calls or relying on AI copilots.  

---

## 🧩 评测标准 | Evaluation Criteria  

- **真实场景任务**：从日常开发中提取问题，而非仅限于基准数据集  
- **一次成功率**：不允许提示工程多次迭代，严格评估模型“一次出手”的可靠性  
- **可复现性**：每个任务附带测试用例，确保结果可验证  
- **多模型对比**：涵盖主流大模型，客观横向比较  

---

## 📊 当前进度 | Current Progress  

- [ ] 任务库构建  
- [ ] 测试用例收集  
- [ ] 自动化评测脚本  
- [ ] 第一版榜单生成  

---

## 🚀 如何参与 | Contributing  

- 提交新的编程任务（issue / PR）  
- 改进测试用例与验证标准  
- 提交评测结果，加入榜单  

Contributions are highly welcome!  
Add new coding tasks, improve evaluation, or share results from your favorite LLM.  

---

## 🌟 为什么重要 | Why This Matters  

在真实开发中，用户通常没有时间去反复调整提示。  
**一次成功率** 才能真正衡量模型的实用性和可靠性。  

By focusing on **one-shot coding performance**, this leaderboard provides developers and teams with **practical insights** into which models can truly deliver under real-world constraints.