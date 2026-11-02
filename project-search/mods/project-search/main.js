// Project search, like Zed's: ctrl-shift-f opens the dialog (search, replace, filters);
// a match opens in a viewer pane beside the shell (this mod again, with props().file).

import { View } from "gpui-kit";
import { props } from "herdr";
import { SearchDialog } from "./search.js";
import { FileViewer } from "./viewer.js";

export default class ProjectSearch extends View {
  init(_props, cx) {
    this.part = props()?.file ? new FileViewer() : new SearchDialog();
    this.part.init(cx);
  }

  render(cx) {
    return this.part.render(cx);
  }

  close() {
    this.part.close?.();
  }
}
