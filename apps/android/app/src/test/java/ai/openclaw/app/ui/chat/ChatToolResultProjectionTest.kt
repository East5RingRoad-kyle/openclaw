package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatMessageProvenance
import ai.openclaw.app.chat.ChatToolActivity
import ai.openclaw.app.chat.ChatTranscriptMarker
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class ChatToolResultProjectionTest {
  private fun activity(
    id: String,
    type: String,
    tool: ChatToolActivity,
  ) = ChatMessage(id, if (type == "toolCall") "assistant" else "toolresult", listOf(ChatMessageContent(type = type, toolActivity = tool)), 1)

  private fun text(
    id: String,
    role: String = "assistant",
  ) = ChatMessage(id, role, listOf(ChatMessageContent(type = "text", text = id)), 1)

  private fun timeline(messages: List<ChatMessage>) = buildChatTimeline(messages, 0, emptyList(), null)

  @Test
  fun resultAcrossCommentaryUpdatesOriginalInvocationWithoutGenericRow() {
    val call = ChatToolActivity("call-1", "bash", "command: pwd", null, false)
    val result = ChatToolActivity("call-1", "tool", null, "/workspace", false)
    val built = timeline(listOf(activity("call", "toolCall", call), text("commentary"), activity("result", "toolResult", result), text("final")))
    assertEquals(listOf("message:final", "message:commentary", "completed-tools:call"), built.items.map(::chatTimelineItemKey))
    assertEquals(
      listOf(call.copy(result = "/workspace")),
      built.items
        .filterIsInstance<ChatTimelineItem.CompletedTools>()
        .single()
        .tools,
    )
  }

  @Test
  fun matchedFailuresOnlyCollapseWhenALaterAnswerExists() {
    val call = ChatToolActivity("call-1", "bash", "command: check draft", null, false)
    val failure = call.copy(name = "tool", detail = null, result = "Draft check failed", isError = true)
    val earlier = ChatToolActivity("earlier", "read", "path: draft.md", null, false)
    val earlierResult = earlier.copy(result = "Draft read")
    for (mixed in listOf(false, true)) {
      val invocation =
        activity("call", "toolCall", call).let {
          if (mixed) it.copy(content = listOf(ChatMessageContent(text = "Checking the draft")) + it.content) else it
        }
      val answer = text("final").copy(phase = "final_answer")
      val result = activity("result", "toolResult", failure)
      for (late in listOf(false, true)) {
        val history = listOf(text("prompt", "user"), text("commentary"), activity("earlier", "toolCall", earlier), activity("earlier-result", "toolResult", earlierResult), invocation) + if (late) listOf(answer, result) else listOf(result, answer)
        val built = timeline(history)
        assertEquals(2, built.items.filterIsInstance<ChatTimelineItem.CompletedTools>().sumOf { it.tools.size })
        val collapsed = built.withCompletedWorkGroups(history, false, emptySet(), "main", "main")
        assertEquals(
          "mixed=$mixed late=$late",
          if (late) (if (mixed) emptyList() else listOf(earlierResult)) + call.copy(result = failure.result, isError = true) else emptyList(),
          collapsed.items.filterIsInstance<ChatTimelineItem.CompletedTools>().flatMap { it.tools },
        )
        assertEquals(listOf("final", "prompt"), collapsed.items.filterIsInstance<ChatTimelineItem.Message>().map { it.message.id })
      }
    }
  }

  @Test
  fun mixedMessagesUseResolvedToolCompletionWithoutChangingCanonicalContent() {
    val call = ChatToolActivity("mixed-call", "read", "path: draft.md", null, false)
    for (phase in listOf("final_answer", "commentary")) {
      for (output in listOf("Draft read", null)) {
        for (messageError in listOf(false, true)) {
          val mixed =
            text("mixed").copy(
              content = listOf(ChatMessageContent(text = "mixed"), ChatMessageContent(type = "toolCall", toolActivity = call)),
              phase = phase,
              isError = messageError,
              entryId = "mixed-entry",
              truncated = true,
            )
          val priorAnswer = if (phase == "commentary") listOf(text("final").copy(phase = "final_answer")) else emptyList()
          val history =
            listOf(text("prompt", "user"), text("work").copy(phase = "commentary")) + priorAnswer + mixed +
              activity("result", "toolResult", call.copy(result = output))
          val built = timeline(history)
          assertSame(
            mixed,
            built.items
              .filterIsInstance<ChatTimelineItem.Message>()
              .single { it.message.id == "mixed" }
              .message,
          )
          val collapsed = built.withCompletedWorkGroups(history, false, emptySet(), "main", "main")
          val expected =
            when {
              phase == "final_answer" && messageError -> listOf("mixed", "work", "prompt")
              phase == "final_answer" -> listOf("mixed", "prompt")
              messageError -> listOf("mixed", "final", "prompt")
              else -> listOf("final", "prompt")
            }
          assertEquals("phase=$phase output=$output error=$messageError", expected, collapsed.items.filterIsInstance<ChatTimelineItem.Message>().map { it.message.id })
          assertEquals(if (phase == "final_answer" && messageError) 0 else 1, collapsed.items.filterIsInstance<ChatTimelineItem.WorkedSummary>().size)
          assertEquals(1, built.items.filterIsInstance<ChatTimelineItem.CompletedTools>().sumOf { it.tools.size })
          if (!messageError) assertEquals(0, collapsed.items.filterIsInstance<ChatTimelineItem.CompletedTools>().size)
        }
      }
    }
  }

  @Test
  fun adjacentReplylessRunKeepsItsOwnResultOutsideEarlierCompletedWork() {
    val first = ChatToolActivity("a", "read", null, "First run result", false)
    val second = ChatToolActivity("b", "read", null, "Independent run result", false)
    for (earlyCall in listOf(false, true)) {
      val history =
        listOf(text("prompt", "user").copy(runId = "run-b")) +
          (if (earlyCall) listOf(activity("b-call", "toolCall", second.copy(result = null)).copy(runId = "run-b")) else emptyList()) +
          listOf(
            text("final").copy(runId = "run-a", phase = "final_answer"),
            activity("a", "toolResult", first).copy(runId = "run-a"),
            activity("b", "toolResult", second).copy(runId = "run-b"),
          )
      val built = timeline(history)
      for (active in listOf(null, "run-b")) {
        val collapsed = built.withCompletedWorkGroups(history, false, emptySet(), "main", "main", activeRunId = active)
        if (active == null) {
          assertEquals(listOf(second), collapsed.items.filterIsInstance<ChatTimelineItem.CompletedTools>().flatMap { it.tools })
        } else {
          assertEquals(built.items, collapsed.items)
        }
        assertEquals(listOf("final", "prompt"), collapsed.items.filterIsInstance<ChatTimelineItem.Message>().map { it.message.id })
      }
    }
  }

  @Test
  fun independentRunFailuresRequireALaterReplyFromThatRun() {
    val call = ChatToolActivity("run-b-call", "read", "path: draft.md", null, false)
    val failure = call.copy(result = "Draft read failed", isError = true)
    val replies = listOf(null, text("run-b-final").copy(phase = "final_answer"), text("run-b-final"))
    for (reply in replies) {
      for (nonReply in listOf(text("run-b-work").copy(phase = "commentary"), text("run-b-work").copy(isError = true))) {
        val history =
          listOf(
            text("prompt", "user").copy(runId = "run-a"),
            text("run-a-work").copy(runId = "run-a", phase = "commentary"),
            activity("call", "toolCall", call).copy(runId = "run-b"),
          ) + listOfNotNull(reply?.copy(runId = "run-b")) +
            listOf(
              nonReply.copy(runId = "run-b"),
              activity("failure", "toolResult", failure).copy(runId = "run-b"),
              text("final").copy(runId = "run-a", phase = "final_answer"),
            )
        val collapsed = timeline(history).withCompletedWorkGroups(history, false, emptySet(), "main", "main")
        val expected =
          listOf("final") +
            (if (reply == null || nonReply.isError) listOf("run-b-work") else emptyList()) +
            (if (reply?.phase == "final_answer") listOf("run-b-final") else emptyList()) + listOf("prompt")
        assertEquals(expected, collapsed.items.filterIsInstance<ChatTimelineItem.Message>().map { it.message.id })
        assertEquals(listOf(failure), collapsed.items.filterIsInstance<ChatTimelineItem.CompletedTools>().flatMap { it.tools })
        assertEquals(1, collapsed.items.filterIsInstance<ChatTimelineItem.WorkedSummary>().size)
      }
    }
  }

  @Test
  fun repeatedToolIdsInDifferentRunsKeepTheirOwnResults() {
    val first = ChatToolActivity("same-id", "read", "path: first.md", null, false)
    val second = first.copy(detail = "path: second.md")
    val history =
      listOf(
        activity("a", "toolCall", first).copy(runId = "run-a"),
        activity("b", "toolCall", second).copy(runId = "run-b"),
        activity("b-result", "toolResult", second.copy(result = "Second failed", isError = true)).copy(runId = "run-b"),
        activity("a-result", "toolResult", first.copy(result = "First succeeded")).copy(runId = "run-a"),
      )
    assertEquals(
      listOf(second.copy(result = "Second failed", isError = true), first.copy(result = "First succeeded")),
      timeline(history).items.filterIsInstance<ChatTimelineItem.CompletedTools>().flatMap { it.tools },
    )
  }

  @Test
  fun suppressesOnlyEmptyUnnamedOrphansAndKeepsRealOutputAndErrors() {
    val empty = ChatToolActivity("orphan", "tool", null, null, false)
    val built =
      timeline(
        listOf(
          activity("empty", "toolResult", empty),
          activity("output", "toolResult", empty.copy(toolCallId = "output", result = "useful output")),
          activity("error", "toolResult", empty.copy(toolCallId = "error", isError = true)),
          activity("named", "toolCall", empty.copy(toolCallId = "named", name = "read")),
        ),
      )
    assertEquals(
      listOf("output", "error", "named"),
      built.items
        .filterIsInstance<ChatTimelineItem.CompletedTools>()
        .flatMap { it.tools }
        .map { it.toolCallId },
    )
    assertEquals(emptyList<ChatTimelineItem>(), timeline(listOf(activity("empty", "toolResult", empty))).items)
  }

  @Test
  fun consecutiveCallResultPairsRemainOneGroup() {
    val first = ChatToolActivity("call-1", "bash", "command: pwd", null, false)
    val second = first.copy(toolCallId = "call-2", detail = "command: ls")
    val groups =
      timeline(
        listOf(
          activity("call-1", "toolCall", first),
          activity("result-1", "toolResult", first.copy(name = "tool", detail = null, result = "/workspace")),
          activity("call-2", "toolCall", second),
          activity("result-2", "toolResult", second.copy(name = "tool", detail = null, result = "file.txt")),
        ),
      ).items.filterIsInstance<ChatTimelineItem.CompletedTools>()
    assertEquals(1, groups.size)
    assertEquals(listOf(first.copy(result = "/workspace"), second.copy(result = "file.txt")), groups.single().tools)
  }

  @Test
  fun transcriptMarkerPreventsMatchingStaleCallIds() {
    val call = ChatToolActivity("call-1", "bash", "command: pwd", null, false)
    val output = ChatToolActivity("call-1", "tool", null, "after boundary", false)
    for (kind in listOf("compaction", "reset")) {
      val marker = ChatMessage("boundary", "system", emptyList(), 2, transcriptMarker = ChatTranscriptMarker(kind = kind))
      val groups =
        timeline(listOf(activity("call", "toolCall", call), marker, activity("result", "toolResult", output)))
          .items
          .filterIsInstance<ChatTimelineItem.CompletedTools>()
      assertEquals(listOf(output, call), groups.flatMap { it.tools })
    }
  }

  @Test
  fun steeringMessagePreservesInvocationResultOwnership() {
    val call = ChatToolActivity("call-1", "bash", "command: pwd", null, false)
    val output = ChatToolActivity("call-1", "tool", null, "completed output", false)
    val groups =
      timeline(
        listOf(
          text("initial", "user").copy(runId = "run-1"),
          activity("call", "toolCall", call),
          text("steering", "user").copy(steerTargetRunId = "run-1"),
          activity("result", "toolResult", output),
        ),
      ).items.filterIsInstance<ChatTimelineItem.CompletedTools>()
    assertEquals(listOf(call.copy(result = "completed output")), groups.flatMap { it.tools })
  }

  @Test
  fun hiddenBoundariesFenceToolGroupsAndReusedCallIds() {
    val call = ChatToolActivity("call-1", "bash", "command: pwd", null, false)
    val output = ChatToolActivity("call-1", "tool", null, "new turn output", false)
    val oldCall = activity("call", "toolCall", call)
    val result = activity("result", "toolResult", output)
    val emptyBoundary = activity("boundary", "toolResult", ChatToolActivity("empty", "tool", null, null, false)).copy(turnBoundary = true)
    for (history in listOf(
      listOf(oldCall, result.copy(turnBoundary = true)),
      listOf(oldCall, emptyBoundary, result),
    )) {
      val groups = timeline(history).items.filterIsInstance<ChatTimelineItem.CompletedTools>()
      assertEquals(2, groups.size)
      assertEquals(listOf(output, call), groups.flatMap { it.tools })
      assertEquals(listOf(true, false), groups.map { it.turnBoundary })
    }
  }

  @Test
  fun forwardedUserInputFencesPreviousTurnToolCallIds() {
    val call = ChatToolActivity("call-1", "bash", "command: pwd", null, false)
    val output = ChatToolActivity("call-1", "tool", null, "new turn output", false)
    val report =
      text("forwarded").copy(
        provenance = ChatMessageProvenance(kind = "inter_session", sourceTool = "sessions_send"),
      )
    for (forwarded in listOf(report, report.copy(content = emptyList()))) {
      val history = listOf(activity("call", "toolCall", call), text("previous-final"), forwarded, activity("result", "toolResult", output), text("new-final"))
      val built = timeline(history)
      val groups = built.items.filterIsInstance<ChatTimelineItem.CompletedTools>()
      assertEquals(2, groups.size)
      assertEquals(listOf(output, call), groups.flatMap { it.tools })
      assertEquals(forwarded.content.isNotEmpty(), built.items.filterIsInstance<ChatTimelineItem.Message>().any { it.message.id == "forwarded" })
      val collapsed = built.withCompletedWorkGroups(history, false, emptySet(), "agent:main:dashboard:test", "agent:main:main")
      assertEquals(
        listOf("new-final", "previous-final"),
        collapsed.items
          .filterIsInstance<ChatTimelineItem.Message>()
          .map { it.message.id }
          .filterNot { it == "forwarded" },
      )
    }
  }

  @Test
  fun doesNotAttachReusedCallIdsAcrossUserTurns() {
    val call = ChatToolActivity("call-1", "bash", "command: pwd", null, false)
    val output = ChatToolActivity("call-1", "tool", null, "new turn output", false)
    val groups =
      timeline(listOf(activity("call", "toolCall", call), text("next-turn", "user"), activity("result", "toolResult", output)))
        .items
        .filterIsInstance<ChatTimelineItem.CompletedTools>()
    assertEquals(listOf(output, call), groups.flatMap { it.tools })
  }
}
