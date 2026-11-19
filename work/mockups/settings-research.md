# Settings research

Reviewed November 19, 2026. The survey covers 31 distinct product and provider websites, including separately documented Microsoft products. Each observation comes from an opened first-party help or developer page. Provider screenshots depict documented interfaces. Signed-in workflows and usability remain untested.

## Spelling and dictionaries

| Product | Documented behavior |
| --- | --- |
| Apple macOS | Keyboard settings select the languages to check. The text context menu distinguishes ignoring a spelling in the current document from learning or unlearning it in the dictionary. [macOS User Guide](https://support.apple.com/en-mz/guide/mac-help/mchlp2299/mac) |
| Brave | Settings → Language lists preferred languages and lets people remove a language through a row menu. [Brave Help Center](https://support.brave.app/hc/en-us/articles/360017901232-How-do-I-change-my-language) |
| Discord | Its documented desktop workflow adds words from the message context menu. To undo an accidental addition, Discord directs people to their computer’s spelling settings. [Discord Support](https://support.discord.com/hc/en-us/articles/360000877191-Spellcheck-in-Discord) |
| Figma | The Text → Spell check menu holds the toggle and preferred language. The editor context menu adds a personal word, and Figma documents that it cannot be removed. [Figma Learn](https://help.figma.com/hc/en-us/articles/27323589692055-Use-spell-check) |
| Google Chrome | Settings → Languages contains spell check and distinguishes basic from enhanced checking. [Chrome Help](https://support.google.com/chrome/answer/12027911?hl=en-VU) |
| Grammarly | Account → Writing → Your dictionary lists custom words with an input to add a word and a trash icon on hover to remove an entry. The suggestion card also offers Add to dictionary. [Grammarly Support](https://support.grammarly.com/hc/en-us/articles/115000091491-How-do-I-use-my-personal-dictionary) |
| JetBrains ReSharper | Its Spelling settings support adding a language dictionary by choosing a Hunspell dictionary file. [ReSharper Documentation](https://www.jetbrains.com/help/resharper/Settings_Grammar_Spelling_Spelling.html) |
| LanguageTool | Team Dictionary settings export the word list and import a replacement. Dropping a word from the replacement file deletes the entry on import. [LanguageTool Help](https://help.languagetool.org/hc/en-us/articles/39254502745239-How-to-import-an-existing-Dictionary-into-LanguageTool) |
| LibreOffice | Languages and Locales → Writing Aids lets people pick a user-defined dictionary, open it and delete an individual word. [LibreOffice Help](https://help.libreoffice.org/latest/en-US/text/swriter/guide/delete_from_dict.html?DbPAR=&System=UNIX) |
| Microsoft Word | On Windows, the Proofing options open Custom Dictionaries, where people can select a dictionary and add, edit or delete individual words. A custom dictionary can apply to all languages or to a chosen language. [Microsoft Support](https://support.microsoft.com/en-us/word/add-or-edit-words-in-a-spell-check-dictionary) |
| Mozilla Firefox | Firefox documents removing an added word by opening the profile dictionary file in a text editor and deleting the corresponding line. [Firefox Help](https://support.mozilla.org/en-US/kb/how-do-i-use-firefox-spell-checker?esab=a&r=1&s=default+language+spell-check) |
| Obsidian | Editor settings put Spellcheck under Behavior. A gear in that setting lets people remove saved entries from the custom dictionary. [Obsidian Help](https://obsidian.md/help/settings) |
| ONLYOFFICE | The status bar chooses the language for the document or a passage. The desktop editor also offers a custom dictionary shared across its three editors. [ONLYOFFICE Help Center](https://helpcenter.onlyoffice.com/docs/userguides/document-editor/tools-and-settings/spell-checking) |
| Opera | The browser settings group turning spell check on or off and customizing it under Spell check. [Opera Help](https://help.opera.com/en/faq/) |
| ProWritingAid | A spelling suggestion can add a word. The personal dictionary page lists saved words and allows additions and deletions. [ProWritingAid Help Center](https://help.prowritingaid.com/article/102-how-do-i-add-a-word-to-my-personal-dictionary) |
| Slack | Preferences → Language & region offers the spell-check toggle. On macOS, the system spell checker determines which languages are checked. [Slack Help](https://slack.com/help/articles/215058658-Manage-your-language-preferences) |
| Vivaldi | Windows and Linux let people add and delete custom words in Language settings. The browser also has a search field above its settings categories to find a setting by name. [Spell checker](https://help.vivaldi.com/desktop/tools/spell-checker/) · [Settings](https://help.vivaldi.com/desktop/appearance-customization/settings/) |
| Zoho Writer | The personal dictionary allows individual additions and removals. The spell-check panel controls which domain dictionaries are enabled. [Zoho Writer Help](https://help.zoho.com/portal/en/kb/writer/how-to-customize-writer/editor-settings/articles/manage-your-dictionary-zoho-writer) |

## Navigation and credentials

| Product | Documented behavior |
| --- | --- |
| Atlassian | The account provides an API token area under security, separate from the help paths for profile and language preferences. [Atlassian Support](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/) |
| Dropbox | Desktop app preferences apply to a device. Account-wide settings, including connected apps, have their own web settings. [Desktop preferences](https://help.dropbox.com/account-settings/view-preferences) · [Account settings](https://help.dropbox.com/account-settings/account-settings?fallback=true) |
| GitHub | Account Settings places personal access tokens under Developer settings in the sidebar. [GitHub Docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) |
| GitLab | Access → Personal access tokens is a dedicated settings area, with search scoped to the token list. [GitLab Docs](https://docs.gitlab.com/user/profile/personal_access_tokens/) |
| Linear | Spell check is a preference. Personal API keys are created under Account → Security & Access. [Preferences](https://linear.app/docs/account-preferences) · [API and webhooks](https://linear.app/docs/api-and-webhooks?noRedirect=1) |
| Notion | Settings has a Connections destination for managing workspace integrations. Display language lives in Preferences under Language & Time. [Connections](https://www.notion.com/en-gb/help/add-and-manage-connections-with-the-api?nxtPslug=add-and-manage-connections-with-the-api) · [Language](https://www.notion.com/en-gb/help/change-your-language) |
| OpenAlex | Its help directs users to Settings → API key to copy or rotate a key. The public view of the settings URL exposed no account controls. [Authentication](https://help.openalex.org/api/authentication/) · [Settings URL](https://openalex.org/settings/api) |
| Raycast | Extensions appear individually in the settings sidebar. Each extension has a place for its own preferences, authentication or access tokens. [Raycast Manual](https://manual.raycast.com/settings) |
| Sentry | User-scoped personal tokens are managed in the user’s account under Personal Tokens. Sentry documents organization tokens separately. [Sentry Help](https://www.sentry.help/en/articles/15902365-how-do-i-manage-and-secure-personal-tokens-in-sentry-io) |
| Stripe | A dedicated Dashboard page creates, reveals, expires and rotates API keys for the account or sandbox being viewed. [Stripe Docs](https://docs.stripe.com/keys) |
| Visual Studio Code | The graphical settings editor supports category navigation and search, including a filter for modified settings, with user and workspace scopes. [VS Code Docs](https://code.visualstudio.com/docs/configure/settings) |
| Zed | The Settings Editor supports search across settings. The documentation also lists the corresponding configuration values for direct editing. [Zed Docs](https://zed.dev/docs/reference/all-settings) |
| Zoom | The desktop Settings window opens from either the profile menu or the navigation bar’s gear. It groups related controls into task-specific tabs such as Audio. [Zoom Support](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060612) |

## Implications for the mockup

- Give Appearance, Writing and Integrations their own visible destinations. Search in Vivaldi, VS Code and Zed can save navigation through large catalogs. Three visible destinations make the starting points easy to scan, while a search box would add another control and a second way of finding the same few settings. The trade-off at this scale remains a design judgment.
- Place Spell check and Personal dictionary together in Writing. Keep the language checked while writing independent from the dictionary currently being browsed. Use a visible removal action for every saved word. Obsidian offers the closest documented placement, while Vivaldi and ProWritingAid show direct management of individual entries. An existing in-editor add action can serve as a shortcut for the word at hand.
- Put the OpenAlex API key in Integrations. A provider-specific label and a link to the provider’s API key location help people distinguish acquiring a key from saving it in the Workbench. Linear and Notion document comparable separation between preferences and access or connections.
