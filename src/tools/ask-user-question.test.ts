import assert from 'node:assert/strict'
import test from 'node:test'

import { askUserQuestionTool } from './ask-user-question.js'

const validInput = {
  questions: [{
    header: 'Name',
    question: 'What should this skill be called?',
    options: [{ label: 'skillify' }, { label: 'workflow' }],
    defaultOptionIndex: 0,
  }],
}

test('AskUserQuestion schema accepts 1-4 questions with 2-4 options', () => {
  const parsed = askUserQuestionTool.inputSchema?.safeParse(validInput)
  assert.equal(parsed?.success, true)
})

test('AskUserQuestion schema rejects invalid question and option counts', () => {
  assert.equal(askUserQuestionTool.inputSchema?.safeParse({ questions: [] }).success, false)
  assert.equal(
    askUserQuestionTool.inputSchema?.safeParse({
      questions: Array.from({ length: 5 }, () => validInput.questions[0]),
    }).success,
    false,
  )
  assert.equal(
    askUserQuestionTool.inputSchema?.safeParse({
      questions: [{ ...validInput.questions[0], options: [{ label: 'only' }] }],
    }).success,
    false,
  )
})

test('AskUserQuestion schema rejects long headers and out-of-range defaults', () => {
  assert.equal(
    askUserQuestionTool.inputSchema?.safeParse({
      questions: [{ ...validInput.questions[0], header: 'too-long-header' }],
    }).success,
    false,
  )
  assert.equal(
    askUserQuestionTool.inputSchema?.safeParse({
      questions: [{ ...validInput.questions[0], defaultOptionIndex: 2 }],
    }).success,
    false,
  )
  // defaultOptionIndex is required so timeout always has a forward-progress
  // path — schema must reject a question that omits it.
  const { defaultOptionIndex: _, ...withoutDefault } = validInput.questions[0]!
  assert.equal(
    askUserQuestionTool.inputSchema?.safeParse({
      questions: [withoutDefault],
    }).success,
    false,
  )
})

test('AskUserQuestion formatter marks timeout defaults explicitly', () => {
  const block = askUserQuestionTool.formatResult({
    answers: [{
      question: 'Scope?',
      header: 'Scope',
      selectedLabels: ['Narrow'],
      byTimeoutDefault: true,
    }],
  }, 'toolu_1')
  assert.match(String(block.content), /timeout default/)
})

test('AskUserQuestion formatter renders per-question otherText on its own line', () => {
  const block = askUserQuestionTool.formatResult({
    answers: [
      {
        question: 'Scope?',
        header: 'Scope',
        selectedLabels: ['Narrow'],
        otherText: 'plus the API surface',
        byTimeoutDefault: false,
      },
      {
        question: 'Tools?',
        header: 'Tools',
        selectedLabels: ['Read', 'Edit'],
        byTimeoutDefault: false,
      },
    ],
  }, 'toolu_2')
  const content = String(block.content)
  assert.match(content, /Scope: Narrow\n {2}other: plus the API surface/)
  assert.match(content, /Tools: Read, Edit/)
  assert.equal(content.split('other:').length, 2, 'no other line for answers without otherText')
})
