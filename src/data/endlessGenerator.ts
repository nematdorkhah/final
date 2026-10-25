import { TizhooshanQuestion } from './tizhooshanQuestions'

let endlessCounter = 900000

export function generateRandomTizhooshanQuestion(): TizhooshanQuestion {
  endlessCounter += 1
  const generators = [
    // 1. Arithmetic sequence
    () => {
      const start = Math.floor(Math.random() * 10) + 2
      const step = Math.floor(Math.random() * 6) + 3
      const seq = [start, start + step, start + 2 * step, start + 3 * step]
      const answer = start + 4 * step
      const wrong = [answer - step, answer + 2, answer - 2].filter((w) => w !== answer)
      const options = [String(answer), String(wrong[0]), String(wrong[1]), String(answer + step)].sort(() => 0.5 - Math.random())
      return {
        id: endlessCounter,
        question: `در الگوی عددی ${seq.join('، ')}، جمله بعدی کدام است؟`,
        options,
        correct_index: options.indexOf(String(answer)),
        explanation: `فاصله بین جملات ثابت و برابر با ${step} است: ${seq[3]} + ${step} = ${answer}.`,
        difficulty: 'متوسط',
        stage: 'آزمون رکوردی بی‌پایان',
        badge: '⚡ بی‌پایان',
        xp: 20,
      }
    },

    // 2. Square number sequence
    () => {
      const offset = Math.floor(Math.random() * 4) + 1
      const n = Math.floor(Math.random() * 4) + 2
      const seq = [1 * 1 + offset, 2 * 2 + offset, 3 * 3 + offset, 4 * 4 + offset]
      const answer = 5 * 5 + offset
      const options = [String(answer), String(answer - 2), String(answer + 4), String(answer - 5)].sort(() => 0.5 - Math.random())
      return {
        id: endlessCounter,
        question: `در دنباله ${seq.join('، ')}، عدد بعدی کدام است؟`,
        options,
        correct_index: options.indexOf(String(answer)),
        explanation: `الگوی دنباله برابر n² + ${offset} است: ۵² + ${offset} = ۲۵ + ${offset} = ${answer}.`,
        difficulty: 'سخت',
        stage: 'آزمون رکوردی بی‌پایان',
        badge: '⚡ بی‌پایان',
        xp: 25,
      }
    },

    // 3. Multiplication and addition puzzle
    () => {
      const a = Math.floor(Math.random() * 7) + 3
      const b = Math.floor(Math.random() * 6) + 2
      const prod = a * b
      const sum = a + b
      const options = [
        `حاصل‌ضرب: ${prod}، مجموع: ${sum}`,
        `حاصل‌ضرب: ${prod + 2}، مجموع: ${sum}`,
        `حاصل‌ضرب: ${prod}، مجموع: ${sum + 1}`,
        `حاصل‌ضرب: ${prod - 4}، مجموع: ${sum - 1}`,
      ].sort(() => 0.5 - Math.random())
      return {
        id: endlessCounter,
        question: `اگر دو عدد ${a} و ${b} باشند، حاصل‌ضرب و مجموع آن‌ها کدام گزینه است؟`,
        options,
        correct_index: options.indexOf(`حاصل‌ضرب: ${prod}، مجموع: ${sum}`),
        explanation: `${a} × ${b} = ${prod} و ${a} + ${b} = ${sum}.`,
        difficulty: 'آسان',
        stage: 'آزمون رکوردی بی‌پایان',
        badge: '⚡ بی‌پایان',
        xp: 15,
      }
    },

    // 4. Anagram / Palindrome verbal
    () => {
      const words = [
        { word: 'مار', rev: 'رام', meaning: 'آرام و اهلی' },
        { word: 'کاخ', rev: 'خاک', meaning: 'تربت و خاک زمین' },
        { word: 'درد', rev: 'درد', meaning: 'یکسان از دو سو' },
        { word: 'شیر', rev: 'ریش', meaning: 'محاسن و موی صورت' },
      ]
      const chosen = words[Math.floor(Math.random() * words.length)]
      const options = [chosen.rev, 'مهر', 'یار', 'نور'].sort(() => 0.5 - Math.random())
      return {
        id: endlessCounter,
        question: `حروف واژه «${chosen.word}» اگر از چپ به راست (برعکس) خوانده شود، کدام کلمه ساخته می‌شود؟`,
        options,
        correct_index: options.indexOf(chosen.rev),
        explanation: `با معکوس کردن حروف واژه «${chosen.word}»، کلمه «${chosen.rev}» به معنی ${chosen.meaning} به دست می‌آید.`,
        difficulty: 'متوسط',
        stage: 'آزمون رکوردی بی‌پایان',
        badge: '⚡ بی‌پایان',
        xp: 20,
      }
    },
  ]

  const pick = generators[Math.floor(Math.random() * generators.length)]
  return pick()
}
