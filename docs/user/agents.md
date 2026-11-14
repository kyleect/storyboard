# Agents

An agent is a helper with its own job, instructions and tools. You can make as many as you like.

## Agents that come with the app

- **Dispatcher.** The default helper for new chats. It looks at what you ask and passes it to a better helper if there is one.
- **Media Describer.** Writes a short description of a picture or sound.

You can't change the built-in agents. You can copy one and change the copy.

## Make an agent

1. Click **Agents** in the rail.
2. Make a new agent.
3. Give it a **Name** and a short **Description**.
4. Write its **System prompt**. This tells it who it is and how to behave.
5. Choose its tools.
6. Save.

### A good system prompt

- Keep it short.
- Say what the agent is for.
- Say what it should always do.
- Say what it should never do.

For example: "You help plan family dinners. Always ask about food allergies first. Keep answers short."

## Choose tools

The **Tools** part lists everything the agent could use. Tools come in groups, like Files, Workspaces and Structured Data.

- Tick a group to give the agent all its tools.
- Open a group to pick single tools.
- Tools that change things must be ticked one by one.

There are two modes. **Only the ticked tools** gives it just what you tick. **Every tool except the unticked ones** gives it everything you don't remove.

## Agents as helpers for other agents

An agent can start another agent to do part of a job. The second agent is called a subagent.

- Turn on **Can be started by other agents** to allow it.
- Give it a good **Description**, so other agents know when to pick it.
- When a subagent needs something from you, it asks you in the chat.
- When it finishes, it hands its answer back.

Use [Settings](settings.md) to limit how deep this can go.

## The default agent

New chats start with the default agent. Out of the box, that is Dispatcher.

- Pick another default in **Settings**.
- Or pick one for a single project on the project page.

## Versions

Agents keep older versions. Use **Versions** to look back at an earlier one.
