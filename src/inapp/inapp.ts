import {
  InAppMessage,
  InAppMessagesRequestParams,
  InAppMessageResponse
} from './types';
import { IterablePromise } from '../types';
import { baseIterableRequest } from '../request';
import {
  addButtonAttrsToAnchorTag,
  filterHiddenInAppMessages,
  paintIFrame,
  paintOverlay,
  sortInAppMessages,
  trackMessagesDelivered
} from './utils';
import {
  trackInAppClick,
  trackInAppClose
  // trackInAppConsume,
  // trackInAppOpen
} from '../events';
import { DISPLAY_INTERVAL_DEFAULT } from 'src/constants';

export function getInAppMessages(
  payload: InAppMessagesRequestParams
): IterablePromise<InAppMessageResponse>;
export function getInAppMessages(
  payload: InAppMessagesRequestParams,
  showInAppMessagesAutomatically: true
): {
  pauseMessageStream: () => void;
  resumeMessageStream: () => void;
  request: () => IterablePromise<InAppMessageResponse>;
};
export function getInAppMessages(
  payload: InAppMessagesRequestParams,
  showInAppMessagesAutomatically?: boolean
) {
  if (showInAppMessagesAutomatically) {
    let timer: NodeJS.Timeout | null = null;
    let messageIndex = 0;
    let parsedMessages: InAppMessage[] = [];

    const paintMessageToDOM = () => {
      if (parsedMessages?.[messageIndex]) {
        const activeMessage = parsedMessages[messageIndex];
        /* add the message's html to an iframe and paint it to the DOM */
        const iframe = paintIFrame(
          activeMessage.content.html,
          payload.onOpenScreenReaderMessage || 'in-app iframe message opened'
        );

        const dismissMessage = (url?: string) => {
          /* close the message and start a timer to show the next one */
          trackInAppClose(
            url
              ? {
                  messageId: activeMessage.messageId,
                  clickedUrl: url
                }
              : { messageId: activeMessage.messageId }
          ).catch((e) => e);
          iframe.remove();
          messageIndex += 1;
          timer = global.setTimeout(() => {
            clearTimeout(timer as NodeJS.Timeout);

            paintMessageToDOM();
          }, payload.displayInterval || DISPLAY_INTERVAL_DEFAULT);
        };

        const overlay = paintOverlay(
          activeMessage?.content?.inAppDisplaySettings?.bgColor?.hex,
          activeMessage?.content?.inAppDisplaySettings?.bgColor?.alpha,
          dismissMessage
        );

        const handleEscKeypress = (event: KeyboardEvent) => {
          if (event.key === 'Escape') {
            dismissMessage();
            overlay.remove();
            document.removeEventListener('keydown', handleEscKeypress);
          }
        };

        document.addEventListener('keydown', handleEscKeypress);

        /* 
          track in-app consumes only when _saveToInbox_ 
          is falsy or undefined and always track in-app opens

          Also swallow any 400+ response errors. We don't care about them.
        */
        // Promise.all(
        //   !activeMessage?.saveToInbox
        //     ? [
        //         trackInAppOpen({
        //           messageId: activeMessage.messageId
        //         }),
        //         trackInAppConsume({
        //           messageId: activeMessage.messageId
        //         })
        //       ]
        //     : [
        //         trackInAppOpen({
        //           messageId: activeMessage.messageId
        //         })
        //       ]
        // ).catch((e) => e);

        /* now we'll add click tracking to _all_ anchor tags */
        const links =
          iframe.contentWindow?.document?.querySelectorAll('a') || [];

        for (let i = 0; i < links.length; i++) {
          const link = links[i];
          link.addEventListener('click', (event) => {
            /* 
              remove default linking behavior because we're in an iframe 
              so we need to link the user programatically
            */
            event.preventDefault();
            const clickedUrl = link.getAttribute('href') || '';
            const openInNewTab = link.getAttribute('target') === '_blank';
            const isIterableKeywordLink = !!clickedUrl.match(
              /itbl:\/\/|iterable:\/\/|action:\/\//gim
            );
            const isDismissNode = !!clickedUrl.match(
              /(itbl:\/\/|iterable:\/\/)dismiss/gim
            );

            if (clickedUrl) {
              /* track the clicked link */
              trackInAppClick({
                clickedUrl,
                messageId: activeMessage?.messageId
                /* swallow the network error */
              }).catch((e) => e);

              if (isDismissNode) {
                /* 
                  give the close anchor tag properties that make it 
                  behave more like a button with a logical aria label
                */
                addButtonAttrsToAnchorTag(link, 'close modal');

                dismissMessage(clickedUrl);
                overlay.remove();
              }

              /*
                finally (since we're in an iframe), programatically click the link
                and send the user to where they need to go, only if it's not one
                of the reserved iterable keyword links
              */
              if (!isIterableKeywordLink) {
                if (openInNewTab) {
                  /**
                    Using target="_blank" without rel="noreferrer" and rel="noopener" 
                    makes the website vulnerable to window.opener API exploitation attacks
                    
                    @see https://developer.mozilla.org/en-US/docs/Web/HTML/Element/a
                  */
                  global.open(clickedUrl, '_blank', 'noopenner,noreferrer');
                } else {
                  /* otherwise just link them in the same tab */
                  global.location.href = clickedUrl;
                }
              }
            }
          });
        }

        iframe.contentWindow?.document?.close();
      }
    };

    return {
      request: (): IterablePromise<InAppMessageResponse> =>
        baseIterableRequest<InAppMessageResponse>({
          method: 'GET',
          url: '/inApp/getMessages',
          params: payload
        })
          .then((response) => {
            trackMessagesDelivered(response.data.inAppMessages || []);
            return response;
          })
          .then((response) => {
            /* 
              if the user passed the flag to automatically paint the in-app messages
              to the DOM, start a timer and show each in-app message upon close + timer countdown
              
              However there are 3 conditions in which to not show a message:
              
              1. _read_ key is truthy
              2. _trigger.type_ key is "never"
              3. HTML body is blank

              so first filter out unwanted messages and sort them
            */
            parsedMessages = sortInAppMessages(
              filterHiddenInAppMessages(response.data.inAppMessages)
            ) as InAppMessage[];

            paintMessageToDOM();
            return {
              ...response,
              data: {
                inAppMessages: parsedMessages
              }
            };
          }),
      pauseMessageStream: () => {
        if (timer) {
          clearTimeout(timer);
        }
      },
      resumeMessageStream: () => {
        paintMessageToDOM();
      }
    };
  }

  /* 
    user doesn't want us to paint messages automatically.
    just return the promise like normal
  */
  return baseIterableRequest<InAppMessageResponse>({
    method: 'GET',
    url: '/inApp/getMessages',
    params: payload
  }).then((response) => {
    trackMessagesDelivered(response.data.inAppMessages || []);
    return response;
  });
}
