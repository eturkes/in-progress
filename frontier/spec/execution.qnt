module execution {
  type Phase = Requested | Calling | Executing | Applied | Journaled | Completed | Paused
  type Receipt = None | Success

  var phase: Phase
  var executorReceipt: Receipt
  var workflowReceipt: Receipt
  var callAttemptsInWindow: int
  var committedResultCount: int

  // Three is a finite-state abstraction of Restate's configured 70-attempt retry window.
  pure val MAX_ATTEMPTS = 3

  action init = all {
    phase' = Requested,
    executorReceipt' = None,
    workflowReceipt' = None,
    callAttemptsInWindow' = 0,
    committedResultCount' = 0,
  }

  action callExecutor = all {
    phase == Requested,
    callAttemptsInWindow < MAX_ATTEMPTS,
    phase' = Calling,
    executorReceipt' = executorReceipt,
    workflowReceipt' = workflowReceipt,
    callAttemptsInWindow' = callAttemptsInWindow + 1,
    committedResultCount' = committedResultCount,
  }

  // Physical attempts may repeat; each uses isolated staging output.
  action beginAttempt = all {
    phase == Calling,
    executorReceipt == None,
    phase' = Executing,
    callAttemptsInWindow' = callAttemptsInWindow,
    executorReceipt' = executorReceipt,
    workflowReceipt' = workflowReceipt,
    committedResultCount' = committedResultCount,
  }

  // One transaction promotes a staged result and installs its immutable receipt.
  action commitSuccess = all {
    phase == Executing,
    executorReceipt == None,
    phase' = Applied,
    executorReceipt' = Success,
    callAttemptsInWindow' = callAttemptsInWindow,
    committedResultCount' = committedResultCount + 1,
    workflowReceipt' = workflowReceipt,
  }

  // Same operation key + request returns the existing receipt without another commit.
  action returnRecorded = all {
    phase == Calling,
    executorReceipt == Success,
    phase' = Applied,
    executorReceipt' = executorReceipt,
    workflowReceipt' = workflowReceipt,
    callAttemptsInWindow' = callAttemptsInWindow,
    committedResultCount' = committedResultCount,
  }

  // Failure may cut before commit or after commit but before Restate journals the response.
  action crash = all {
    phase == Calling or phase == Executing or phase == Applied,
    phase' = Requested,
    executorReceipt' = executorReceipt,
    workflowReceipt' = workflowReceipt,
    callAttemptsInWindow' = callAttemptsInWindow,
    committedResultCount' = committedResultCount,
  }

  action pauseExhausted = all {
    phase == Requested,
    callAttemptsInWindow == MAX_ATTEMPTS,
    phase' = Paused,
    executorReceipt' = executorReceipt,
    workflowReceipt' = workflowReceipt,
    callAttemptsInWindow' = callAttemptsInWindow,
    committedResultCount' = committedResultCount,
  }

  action resume = all {
    phase == Paused,
    phase' = Requested,
    executorReceipt' = executorReceipt,
    workflowReceipt' = workflowReceipt,
    callAttemptsInWindow' = 0,
    committedResultCount' = committedResultCount,
  }

  action journalReceipt = all {
    phase == Applied,
    executorReceipt == Success,
    phase' = Journaled,
    workflowReceipt' = executorReceipt,
    executorReceipt' = executorReceipt,
    callAttemptsInWindow' = callAttemptsInWindow,
    committedResultCount' = committedResultCount,
  }

  // Completed means Restate's durable workflow completion, not an external effect.
  action finish = all {
    phase == Journaled,
    workflowReceipt == Success,
    phase' = Completed,
    executorReceipt' = executorReceipt,
    workflowReceipt' = workflowReceipt,
    callAttemptsInWindow' = callAttemptsInWindow,
    committedResultCount' = committedResultCount,
  }

  action completedStutter = all {
    phase == Completed,
    phase' = phase,
    executorReceipt' = executorReceipt,
    workflowReceipt' = workflowReceipt,
    callAttemptsInWindow' = callAttemptsInWindow,
    committedResultCount' = committedResultCount,
  }

  action observe(condition: bool): bool = all {
    assert(condition),
    phase' = phase,
    executorReceipt' = executorReceipt,
    workflowReceipt' = workflowReceipt,
    callAttemptsInWindow' = callAttemptsInWindow,
    committedResultCount' = committedResultCount,
  }

  action step = any {
    callExecutor,
    beginAttempt,
    commitSuccess,
    returnRecorded,
    crash,
    pauseExhausted,
    resume,
    journalReceipt,
    finish,
    completedStutter,
  }

  val oneCommittedResult = committedResultCount <= 1
  val nonnegativeCounters = all {
    callAttemptsInWindow >= 0,
    callAttemptsInWindow <= MAX_ATTEMPTS,
    committedResultCount >= 0,
  }
  val executorReceiptIsSound = executorReceipt != Success or committedResultCount == 1
  val workflowReceiptIsSound = workflowReceipt == None or workflowReceipt == executorReceipt
  val completedIsSound = phase != Completed or all {
    workflowReceipt == Success,
    committedResultCount == 1,
  }
  val pausedIsSound = phase != Paused or all {
    workflowReceipt == None,
    callAttemptsInWindow == MAX_ATTEMPTS,
  }

  val safety = all {
    oneCommittedResult,
    nonnegativeCounters,
    executorReceiptIsSound,
    workflowReceiptIsSound,
    completedIsSound,
    pausedIsSound,
  }

  run crashBeforeCommitRetries = {
    init
      .then(callExecutor)
      .then(beginAttempt)
      .then(crash)
      .then(callExecutor)
      .then(beginAttempt)
      .then(commitSuccess)
      .then(journalReceipt)
      .then(finish)
      .then(observe(all {
        callAttemptsInWindow == 2,
        committedResultCount == 1,
        safety,
      }))
  }

  run crashAfterCommitReplays = {
    init
      .then(callExecutor)
      .then(beginAttempt)
      .then(commitSuccess)
      .then(crash)
      .then(callExecutor)
      .then(returnRecorded)
      .then(journalReceipt)
      .then(finish)
      .then(observe(all {
        callAttemptsInWindow == 2,
        committedResultCount == 1,
        safety,
      }))
  }

  run exhaustionPausesAndResumeCanConverge = {
    init
      .then(callExecutor)
      .then(beginAttempt)
      .then(crash)
      .then(callExecutor)
      .then(beginAttempt)
      .then(crash)
      .then(callExecutor)
      .then(beginAttempt)
      .then(crash)
      .then(pauseExhausted)
      .then(resume)
      .then(callExecutor)
      .then(beginAttempt)
      .then(commitSuccess)
      .then(journalReceipt)
      .then(finish)
      .then(observe(all {
        callAttemptsInWindow == 1,
        committedResultCount == 1,
        safety,
      }))
  }

  run committedReceiptSurvivesPause = {
    init
      .then(callExecutor)
      .then(beginAttempt)
      .then(commitSuccess)
      .then(crash)
      .then(callExecutor)
      .then(crash)
      .then(callExecutor)
      .then(crash)
      .then(pauseExhausted)
      .then(resume)
      .then(callExecutor)
      .then(returnRecorded)
      .then(journalReceipt)
      .then(finish)
      .then(observe(all {
        callAttemptsInWindow == 1,
        committedResultCount == 1,
        safety,
      }))
  }
}
