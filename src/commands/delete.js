import isUrl from 'is-url'
import { URL } from 'url'
import Post from '../models/post'

const getIdFromUrl = inputUrl => {
    const url = new URL(inputUrl)
    const lastSegment = url.pathname.slice(url.pathname.lastIndexOf('/') + 1)

    // Attempt to find ID in the URL. Format: pXXXXXXXXXXXXXXXX
    if (!lastSegment.startsWith('p') && lastSegment.length !== 17) {
        return null
    }

    const id = lastSegment.slice(1) // XXXXXXXXXXXXXXXX
    const insertPos = id.length - 6
    // NOTE: Slack's web API is picky about the period. Now formatted as XXXXXXXXXX.XXXXXX
    const formattedId = id.slice(0, insertPos) + '.' + id.slice(insertPos)
    return formattedId
}

const isUserInChannel = async (api, user, channel) => {
    // TODO: Handle pagination
    const res = await api.conversations.members({ channel })
    return res.members.includes(user)
}

// /prox delete <post number|url>
export default async (bot, message, args) => {
    // Check if the user is part of the review channel
    if (!(await isUserInChannel(bot.api, message.user, process.env.SLACK_REVIEW_CHANNEL_ID))) {
        await bot.replyEphemeral(message, 'You don’t have permission to run this command')
        return
    }

    if (!args[1]) {
        await bot.replyEphemeral(message, 'Please specify a post number or message URL')
        return
    }

    // Check if target is post or thread reply
    let messageId
    if (isUrl(args[1])) { // Is URL?
        messageId = getIdFromUrl(args[1])
        if (!messageId) {
            await bot.replyEphemeral(message, 'Couldn’t extract a message ID from the given URL')
            return
        }
    } else if (!isNaN(args[1])) { // Is post number?
        const post = await Post.findOne({ postNumber: args[1] })
        if (!post) {
            await bot.replyEphemeral(message, 'The specified post couldn’t be found')
            return
        }
        messageId = post.postMessageId
    } else { // Is invalid input
        await bot.replyEphemeral(message, 'Input must be a post number or message URL')
        return
    }

    // Delete the message using retrieved ID
    try {
        await bot.deleteMessage({
            id: messageId,
            conversation: { id: process.env.SLACK_POST_CHANNEL_ID },
        })
        await bot.replyEphemeral(message, 'Message deleted')
    } catch (e) {
        await bot.replyEphemeral(message, `Failed to delete. Reason: \`${e.data.error}\``)
    }
}