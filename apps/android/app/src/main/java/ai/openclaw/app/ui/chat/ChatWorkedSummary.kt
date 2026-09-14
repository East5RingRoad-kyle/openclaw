package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp

/** Fold completed output around its answers without changing the canonical transcript. */
internal fun ChatTimeline.withCompletedWorkGroups(
  messages: List<ChatMessage>,
  runWorking: Boolean,
  expandedKeys: Set<String>,
  sessionKey: String,
  mainSessionKey: String,
  activeRunId: String? = null,
): ChatTimeline {
  val key = sessionKey.trim().lowercase()
  val sessionParts = key.split(':')
  val agentSession = sessionParts.size >= 3 && sessionParts[0] == "agent" && sessionParts[1].isNotBlank()
  val main = key == "main" || key == mainSessionKey.trim().lowercase() || (agentSession && sessionParts.size == 3 && sessionParts[2] == "main")
  val dashboard = agentSession && sessionParts.size == 4 && sessionParts[2] == "dashboard" && sessionParts[3].isNotBlank()
  if (!main && !dashboard) return this
  val chronological = items.asReversed()
  val turns = mutableListOf<MutableList<ChatTimelineItem>>()
  chronological.forEach { item ->
    val startsTurn =
      when (item) {
        is ChatTimelineItem.Message -> {
          item.turnBoundary ||
            item.message.role
              .trim()
              .equals("user", ignoreCase = true) || item.message.isForwardedBoundary()
        }

        is ChatTimelineItem.CompletedTools -> {
          item.turnBoundary
        }

        is ChatTimelineItem.SystemDivider, is ChatTimelineItem.SystemNotice -> {
          true
        }

        else -> {
          false
        }
      }
    if (turns.isEmpty() || startsTurn) turns.add(mutableListOf())
    turns.last().add(item)
  }
  val sourceMessages = messages.associateBy { it.entryId ?: it.idempotencyKey ?: it.id }
  val sourcePositions = messages.withIndex().associate { it.value.id to it.index }

  fun source(item: ChatTimelineItem): ChatMessage? =
    when (item) {
      is ChatTimelineItem.Message -> item.message
      is ChatTimelineItem.CompletedTools -> sourceMessages[item.key]
      else -> null
    }

  fun isOutput(item: ChatTimelineItem): Boolean =
    when (item) {
      is ChatTimelineItem.CompletedTools -> {
        true
      }

      is ChatTimelineItem.Message -> {
        item.message.role
          .trim()
          .equals("assistant", ignoreCase = true) && !item.message.isForwardedBoundary()
      }

      else -> {
        false
      }
    }

  fun hasMedia(message: ChatMessage) = message.content.any { it.toolActivity == null && it.type != "text" }

  fun hasReplyContent(message: ChatMessage) = hasMedia(message) || message.content.any { it.type == "text" && !it.text.isNullOrBlank() }

  fun hasUnresolvedWork(item: ChatTimelineItem): Boolean =
    when (item) {
      is ChatTimelineItem.CompletedTools -> item.hasUnresolvedTools
      is ChatTimelineItem.Message -> item.message.isError || item.hasUnresolvedTools
      else -> false
    }

  fun isCompletedReply(item: ChatTimelineItem): Boolean = item is ChatTimelineItem.Message && isOutput(item) && hasReplyContent(item.message) && item.message.phase != "commentary" && !hasUnresolvedWork(item)

  fun isWork(item: ChatTimelineItem): Boolean = isOutput(item) && (item !is ChatTimelineItem.Message || (!hasMedia(item.message) && item.message.phase != "final_answer"))
  // Steering messages continue an existing run; they are not completed-turn boundaries.
  val runTurns = mutableMapOf<String, Int>()
  val continuations = mutableMapOf<Int, Int>()
  val preceding = mutableMapOf<Int, Int>()
  val tails = mutableMapOf<Int, Int>()
  turns.forEachIndexed { index, turn ->
    val user =
      (turn.firstOrNull() as? ChatTimelineItem.Message)?.message?.takeIf {
        it.role.equals("user", ignoreCase = true)
      }
    user?.runId?.let { runTurns.putIfAbsent(it, index) }
    var previous = user?.steerTargetRunId?.let(runTurns::get) ?: return@forEachIndexed
    if (previous >= index) return@forEachIndexed
    val ancestors = mutableListOf<Int>()
    while (previous in tails) {
      ancestors.add(previous)
      previous = tails.getValue(previous)
    }
    continuations[previous] = index
    preceding[index] = previous
    tails[previous] = index
    ancestors.forEach { tails[it] = index }
  }
  val finalIndexes =
    turns.mapIndexed { index, turn ->
      if (index in continuations) {
        -1
      } else {
        turn.indexOfLast(::isCompletedReply)
      }
    }
  val terminalReplies =
    turns
      .mapIndexed { index, turn ->
        turn.getOrNull(finalIndexes[index]) as? ChatTimelineItem.Message
      }.toMutableList()
  for (index in turns.lastIndex - 1 downTo 0) {
    if (terminalReplies[index] == null) continuations[index]?.let { terminalReplies[index] = terminalReplies[it] }
  }
  val liveTurns = mutableSetOf<Int>()
  turns.forEachIndexed { turnIndex, turn ->
    if ((runWorking && turnIndex == turns.lastIndex) || (activeRunId != null && turn.any { source(it)?.runId == activeRunId })) {
      var index = turnIndex
      while (liveTurns.add(index)) index = preceding[index] ?: break
    }
  }
  val rendered =
    buildList {
      turns.forEachIndexed { turnIndex, turn ->
        val live =
          turnIndex in liveTurns ||
            turn.any {
              it is ChatTimelineItem.StreamingAssistant || it is ChatTimelineItem.PendingTools || it == ChatTimelineItem.Thinking
            }
        val finalIndex = finalIndexes[turnIndex]
        val terminal = terminalReplies[turnIndex]
        if (live || terminal == null) {
          addAll(turn)
        } else {
          var start = if (finalIndex >= 0) finalIndex else turn.lastIndex
          var end = start
          if (!isOutput(turn[start])) {
            addAll(turn)
            return@forEachIndexed
          }
          while (start > 0 && isOutput(turn[start - 1])) start--
          val terminalPosition = sourcePositions.getValue(terminal.message.id)
          val replyPositions =
            turn
              .take(if (finalIndex >= 0) finalIndex + 1 else turn.size)
              .mapNotNull { item ->
                (item as? ChatTimelineItem.Message)?.takeIf(::isCompletedReply)?.message?.let { message ->
                  message.runId?.let { it to sourcePositions.getValue(message.id) }
                }
              }.toMap()
              .toMutableMap()
          terminal.message.runId?.let { replyPositions[it] = terminalPosition }
          while (end < turn.lastIndex && isOutput(turn[end + 1])) {
            val runId = source(turn[end + 1])?.runId
            if (runId != null && runId !in replyPositions) break
            end++
          }
          val work = mutableListOf<ChatTimelineItem>()
          val answers = mutableListOf<ChatTimelineItem>()
          for (index in start..end) {
            val item = turn[index]
            val message = source(item)
            val sourcePosition = message?.let { sourcePositions.getValue(it.id) } ?: -1
            val replyPosition = message?.runId?.let(replyPositions::get) ?: terminalPosition
            val unresolvedPosition = if (item is ChatTimelineItem.CompletedTools) maxOf(sourcePosition, item.lastFailureMessageIndex) else sourcePosition
            val unansweredWork = hasUnresolvedWork(item) && unresolvedPosition >= replyPosition
            val replylessRun = message?.runId?.let { it !in replyPositions } == true
            if (index != finalIndex && isWork(item) && !unansweredWork && !replylessRun) work.add(item) else answers.add(item)
          }
          if (work.isEmpty()) {
            addAll(turn)
            return@forEachIndexed
          }
          val continuationBoundary = continuations[turnIndex]?.let { turns[it].firstOrNull() } as? ChatTimelineItem.Message
          val identity = if (finalIndex >= 0) terminal.message else continuationBoundary?.message ?: terminal.message
          val key = identity.entryId ?: identity.idempotencyKey ?: identity.id
          val boundary = turn.firstOrNull() as? ChatTimelineItem.Message
          val startTime =
            boundary
              ?.takeIf {
                it.message.role
                  .trim()
                  .equals("user", ignoreCase = true)
              }?.message
              ?.timestampMs ?: source(work.first())?.timestampMs
          val endTime = (work.mapNotNull { source(it)?.timestampMs } + listOfNotNull(terminal.message.timestampMs)).maxOrNull()
          val duration = if (startTime != null && endTime != null && terminal.message.timestampMs?.let { it > startTime } == true) endTime - startTime else null
          addAll(turn.take(start))
          add(ChatTimelineItem.WorkedSummary(key, duration, key in expandedKeys))
          if (key in expandedKeys) addAll(work)
          addAll(answers)
          addAll(turn.drop(end + 1))
        }
      }
    }.asReversed()
  return copy(
    items = rendered,
    readAnchorIndex = rendered.indexOfFirst { it is ChatTimelineItem.Message && it.message.id == latestUserMessageId }.takeIf { it >= 0 } ?: latestContentIndex,
  )
}

internal fun workedSummaryLabel(durationMs: Long?): String {
  if (durationMs == null || durationMs <= 0) return nativeString("Worked")
  // Same rounding and two nonzero units as web formatDurationCompact.
  var remaining = if (durationMs < 1000) durationMs else ((durationMs + 500) / 1000) * 1000
  val parts = mutableListOf<String>()
  for ((scale, suffix) in listOf(86_400_000L to "d", 3_600_000L to "h", 60_000L to "m", 1000L to "s", 1L to "ms")) {
    val value = remaining / scale
    remaining %= scale
    if (value > 0) parts.add("$value$suffix")
    if (parts.size == 2) break
  }
  return nativeString("Worked for \$duration", parts.joinToString(" "))
}

@Composable
internal fun ChatWorkedSummary(
  item: ChatTimelineItem.WorkedSummary,
  onToggle: () -> Unit,
) {
  val color = ClawTheme.colors.textMuted
  Column(modifier = Modifier.fillMaxWidth()) {
    Row(
      modifier =
        Modifier
          .fillMaxWidth()
          .semantics { stateDescription = if (item.expanded) nativeString("Expanded") else nativeString("Collapsed") }
          .clickable(role = Role.Button, onClick = onToggle)
          .padding(vertical = 12.dp),
      horizontalArrangement = Arrangement.spacedBy(6.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(workedSummaryLabel(item.durationMs), style = ClawTheme.type.body, color = color)
      Icon(
        if (item.expanded) Icons.Default.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = null,
        tint = color,
        modifier = Modifier.size(16.dp),
      )
    }
    HorizontalDivider(color = ClawTheme.colors.border)
  }
}
