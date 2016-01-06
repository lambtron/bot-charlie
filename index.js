
/**
 * Module dependencies.
 */

var thunkify = require('thunkify-wrap');
var storage = require('./lib/storage');
var urlRegex = require('url-regex');
var Botkit = require('Botkit');
var fmt = require('node-fmt');
var url = require('url');
var _ = require('lodash');
var co = require('co');

/**
 * Assign environmental variables.
 */

var clientId = process.env.clientId;
var clientSecret = process.env.clientSecret;
var port = process.env.PORT || 3000;
if (!clientId || !clientSecret || !port) {
  console.log('Error: clientId, clientSecret, and port are undefined in environment');
  process.exit(1);
}

/**
 * Configure the controller.
 */

var controller = Botkit.slackbot({
  storage: thunkatron(storage())
}).configureSlackApp({
  clientId: clientId,
  clientSecret: clientSecret,
  redirectUri: 'http://localhost:3000/oauth',
  scopes: ['bot']
});

/**
 * Setup web server.
 */

controller.setupWebserver(port, function(err, webserver) {
  controller.createWebhookEndpoints(controller.webserver);
  controller.createOauthEndpoints(controller.webserver, function(err, req, res) {
    if (err) return res.status(500).send('ERROR: ' + err);
    res.send('Success!');
  });
});

/**
 * Setup bots.
 */

var _bots = {};
function trackBot(bot) {
  _bots[bot.config.token] = bot;
}

/**
 * Create bots.
 */

controller.on('create_bot', function(bot, config) {
  // Thunkify the api.
  bot.api = thunkatron(bot.api);

  // If already configured, leave.
  if (_bots[bot.config.token]) return;

  // Otherwise, start RTM.
  bot.startRTM(co.wrap(function *(err) {
    if (err) return err;
    trackBot(bot);

    /**
     * Add team to database.
     */

    var team = {
      id: bot.team_info.id,
      domain: bot.team_info.domain,
      email_domain: bot.team_info.email_domain,
      feed_id: '',
      blacklist: []
    };
    yield controller.storage.teams.save(team);

    /**
     * Analytics.
     */

    // analytics.identify({
    //   userId: config.createdBy,
    //   traits: {
    //   }
    // });

    // analytics.track({
    //   userId: config.createdBy,
    //   event: 'Bot Installed',
    //   properties: {
    //   }
    // });

    /**
     * Initial conversation with bot's creator.
     */

    bot.startPrivateConversation({ user: config.createdBy }, function(err, convo) {
      if (err) return console.log(err);
      convo.say('Hello, I\'m Charlie! I just joined your team. I\'m here to help centralize all links shared within your team\'s Slack!');
      convo.say('Whenever someone in a room I\'m in shares a link, I\'ll publish it to a channel of your choosing.');
      convo.ask('What channel should I publish to? Respond with the channel name or skip by saying \'no\' (you can set this later by mentioning me and saying \'publish to <channel-name>\').', co.wrap(function *(response, convo) {
        if (response.text.toLowerCase() === 'no') {
          convo.say('No problem! Please /invite me to the popular channels where your teammates like to share links :).');
          convo.next();
        }
        var res = yield bot.api.channels.list({});
        var channel = _.filter(res.channels, function(c) {
          return c.name.indexOf(response.text) >= 0;
        });
        if (channel.length > 0) {
          // Save team with new `feed` to database.
          team.feed_name = channel[0].name;
          team.feed_id = channel[0].id;
          yield controller.storage.teams.save(team);
          convo.say('Great! New links will be posted there. The last step is to /invite me to the popular channels where your teammates like to share links :).');
          convo.next();
        } else {
          convo.say('Hmmm, that doesn\'t look like a valid channel name.');
          convo.repeat();
          convo.next();
        }
      }));
    });
  }));
});

/**
 * Open connection.
 */

controller.on('rtm_open', function(bot) {
  console.log('** The RTM api just connected!');
});

/**
 * Close connection.
 */

controller.on('rtm_close', function(bot) {
  console.log('** The RTM api just closed');
  // you may want to attempt to re-open
});

/**
 * Connect all bots.
 */

controller.storage.teams.all(function(err, teams) {
  if (err) throw new Error(err);
  for (var t in teams) {
    if (teams[t].bot) {
      var bot = controller.spawn(teams[t]).startRTM(function(err) {
        if (err) return console.log('Error connecting bot to Slack: ', err);
        trackBot(bot);
      });
    }
  }
});

/**
 * Hear URL(s) in chat.
 */

controller.hears('\<(.*?)\|', ['direct_message', 'direct_mention', 'mention', 'ambient'], function(bot, message) {
  // Thunkify the api.
  bot.api = thunkatron(bot.api);

  // Confirm url is in the message.
  var urls = message.text.match(urlRegex());
  if (!urls || urls.length === 0) return;

  // Compile links array.
  var links = _.map(urls, function(u) {
    return {
      link: u,
      domain: url.parse(u).hostname
    };
  });

  // Remove blacklisted domains.
  // Get blacklisted domains.

  // Ask user if he/she wishes to have the bot broadcast the link to feed.
  bot.startPrivateConversation(message, co.wrap(function *(err, convo) {
    // Get team info.
    var team = yield controller.storage.teams.get(bot.team_info.id);

    // Start conversation.
    convo.ask(fmt('Hey! I saw you just shared a link in <#%s>! Want me to share it to <#%s>?', message.channel, team[0].feed_id), [{
      pattern: bot.utterances.yes,
      callback: co.wrap(function *(response, convo) {
        var text = fmt('<@%s> just shared %s in <#%s>', convo.task.source_message.user, links[0].link, convo.task.source_message.channel);
        bot.say({
          text: text,
          channel: team[0].feed_id
        });
        convo.say('Great! Link is shared. Have a nice day!');
        convo.next();
      })
    }, {
      pattern: bot.utterances.no,
      callback: function(response, convo) {
        convo.ask('No problem! Want to ignore future links from this domain (including the subdomain) for your entire team?', [
          {
            pattern: bot.utterances.yes,
            callback: function(response, convo) {
              convo.say('You got it. Any links from this domain will be ignored. Ask me \'blacklist\' for a list of these domains. Learn how to update these settings with \'blacklist help\'');
              // Add domain to blacklist.
              convo.next();
            }
          },
          {
            pattern: bot.utterances.no,
            callback: function(response, convo) {
              convo.say('No problem. Have a great day!');
              convo.next();
            }
          }
        ]);
        // do something else...
        convo.next();
      }
    }, {
      default: true,
      callback: function(response, convo) {
        // just repeat the question
        convo.repeat();
        convo.next();
      }
    }]);
  }));
});

/**
 * Help.
 */

controller.hears('help', ['direct_message', 'direct_mention', 'mention', 'ambient'], function(bot, message) {
  bot.reply(message, {

  });
  // show ignored domains
  // add <url> to ignored domains
  // remove <url> from ignored domains
  // publish to <channel>
});

/**
 * List blacklisted domains.
 */



/**
 * Remove something from blacklisted domains.
 */


/**
 * Add something to blacklisted domains.
 */


/**
 * Get new links sent to #channel.
 */



/**
 * Private function to deep nest thunkify.
 */

function thunkatron(obj) {
  Object.keys(obj).forEach(function(key) {
    if (typeof obj[key] === 'function') obj[key] = thunkify(obj[key]);
    if (typeof obj[key] === 'object' && obj[key] !== null) obj[key] = thunkatron(obj[key]);
  });
  return obj;
}
