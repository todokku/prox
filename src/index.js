import { Botkit } from 'botkit'
import { SlackAdapter, SlackEventMiddleware, SlackMessageTypeMiddleware } from 'botbuilder-adapter-slack'
import mongoose from 'mongoose'
import { SubmissionLayout } from './blocks'
import Counter from './counter'
import Post from './models/post'
import { createSubmission, hash, sendMessage } from './utils'

// Set up MongoDB
mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })

// Set up Slack adapter
const adapter = new SlackAdapter({
    clientSigningSecret: process.env.SLACK_CLIENT_SIGNING_SECRET,
    clientId: process.env.SLACK_CLIENT_ID,
    clientSecret: process.env.SLACK_CLIENT_SECRET,
    scopes: ['bot', 'chat:write:bot'],
    botToken: process.env.SLACK_CLIENT_BOT_TOKEN
})
adapter.use(new SlackEventMiddleware())
adapter.use(new SlackMessageTypeMiddleware())

const controller = new Botkit({ adapter })
const count = new Counter()

controller.ready(async () => {
    await count.init()
})

// Match replies
const replyPattern = /^\d+:(\s|$)/
controller.hears(replyPattern, 'direct_message', async (bot, message) => {
    const args = message.text.split(' ')
    const postNumber = args[0].slice(0, -1)
    const body = args.slice(1).join(' ')

    // Validate that there's content to send
    if (!body) {
        await bot.say(':confused: You need to enter a reply to send')
        return
    }

    // Validate that the post exists
    const post = await Post.findOne({ postNumber }).exec()
    if (!post) {
        await bot.say(`:confused: I couldn’t seem to find post *#${postNumber}*`)
        return
    }

    await bot.say(`:ok_hand: Your reply to post *#${postNumber}* has been sent`)

    const senderIdHash = hash(message.user, post.salt)
    const displayName = senderIdHash === post.authorIdHash
        ? 'OP'
        : senderIdHash // TODO: Generate friendly display name from hash

    await bot.startConversationInThread(process.env.SLACK_POST_CHANNEL_ID, null, post.postMessageId)
    await bot.say(`*${displayName} said:* ${body}`)
})

// Match non-command DMs
const messagePattern = /^(?!\/).*/
controller.hears(messagePattern, 'direct_message', async (bot, message) => {
    await bot.say(':mag: Your message has been submitted for review')
    await createSubmission(bot, process.env.SLACK_REVIEW_CHANNEL_ID, message)
})

// NOTE: The controller doesn't emit the `block_actions` event like it's supposed
// to. So instead, we catch all messages and then look for it.
controller.on('message', async (bot, message) => {
    if (message.incoming_message.channelData.type !== 'block_actions') {
        return
    }

    const id = message.actions[0].block_id
    const submission = await Post.findById(id).exec()
    // Handle edge case where ticket isn't in database
    if (!submission) {
        await bot.startConversationInThread(message.channel, message.user, message.message.ts)
        await bot.say(':rotating_light: Something went wrong. Reason: `submission not found`')
        return
    }

    const status = message.text

    // Update the ticket's status message
    const props = { id, status, text: submission.body }
    await bot.replyInteractive(message, { blocks: SubmissionLayout(props) })

    if (status === 'approved') {
        const newCount = await count.increment()
        const postMessage = await sendMessage(bot, process.env.SLACK_POST_CHANNEL_ID, `*#${newCount}:* ${submission.body}`)
        submission.postMessageId = postMessage.id
        submission.postNumber = newCount
        submission.approvedAt = Date.now()

        await submission.save()
    } else {
        await Post.deleteOne({ _id: id }).exec()
    }
})