const fs = require('fs');
const app = fs.readFileSync('app.js', 'utf-8');

const start = app.indexOf('function parseTextToQuestions');
const end = app.indexOf('/* ============ 解析预览 ============ */');
const code = app.slice(start, end);

const fnRef = new Function(code + '\nreturn { parseTextToQuestions };');
const { parseTextToQuestions } = fnRef();

const text = fs.readFileSync('docx-text.txt', 'utf-8');
const result = parseTextToQuestions(text);

console.log('==== 章节统计 ====');
result.forEach((sec, i) => {
  const typeStats = {};
  sec.questions.forEach(q => {
    typeStats[q.qtype] = (typeStats[q.qtype] || 0) + 1;
  });
  const noAnswer = sec.questions.filter(q => !q.answer).length;
  const noExp = sec.questions.filter(q => !q.explanation).length;
  console.log(`  [${i + 1}] ${sec.name} -- ${sec.questions.length}题 -- 缺答=${noAnswer} 缺解析=${noExp} -- 类型=${JSON.stringify(typeStats)}`);
});

console.log('\n==== 详细检查所有 calc/essay 题 ====');
let totalCalc = 0, totalEssay = 0;
let calcMissingAns = 0, essayMissingAns = 0;
let calcMissingExp = 0, essayMissingExp = 0;
result.forEach((sec) => {
  sec.questions.forEach(q => {
    const isEssay = q.qtype === 'essay';
    const isCalc = q.qtype === 'calc';
    if (isEssay) totalEssay++;
    if (isCalc) totalCalc++;
    if (isEssay && !q.answer) essayMissingAns++;
    if (isEssay && !q.explanation) essayMissingExp++;
    if (isCalc && !q.answer) calcMissingAns++;
    if (isCalc && !q.explanation) calcMissingExp++;
  });
});
console.log(`calc: 总数=${totalCalc}, 缺答案=${calcMissingAns}, 缺解析=${calcMissingExp}`);
console.log(`essay: 总数=${totalEssay}, 缺答案=${essayMissingAns}, 缺解析=${essayMissingExp}`);

// 列举所有"缺答案"的 calc/essay 题
console.log('\n==== 所有缺答案的 calc/essay 题 ====');
result.forEach(sec => {
  sec.questions.forEach(q => {
    if ((q.qtype === 'calc' || q.qtype === 'essay') && !q.answer) {
      console.log(`  [${sec.name}] #${q.num} (${q.qtype}) 缺答案 | 题干=${q.stem.slice(0, 40).replace(/\n/g, '\\n')}...`);
    }
  });
});

// 列举所有"缺解析"的 calc/essay 题
console.log('\n==== 所有缺解析的 calc/essay 题 ====');
result.forEach(sec => {
  sec.questions.forEach(q => {
    if ((q.qtype === 'calc' || q.qtype === 'essay') && !q.explanation) {
      console.log(`  [${sec.name}] #${q.num} (${q.qtype}) 缺解析 | 题干=${q.stem.slice(0, 40).replace(/\n/g, '\\n')}...`);
    }
  });
});
