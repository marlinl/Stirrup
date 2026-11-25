/** Per-conversation reading state, owned only by the mounted workspace view. */
export interface MessageViewState {
  scroll: number;
  follow: boolean;
  expanded: Set<string>;
}
