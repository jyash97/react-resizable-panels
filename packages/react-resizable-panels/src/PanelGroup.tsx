import {
  CSSProperties,
  ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { PanelContext, PanelGroupContext } from "./PanelContexts";
import { Direction, PanelData, ResizeEvent } from "./types";
import { loadPanelLayout, savePanelGroupLayout } from "./utils/serialization";
import { getDragOffset, getMovement } from "./utils/coordinates";
import {
  adjustByDelta,
  getFlexGrow,
  getPanelGroup,
  getResizeHandlePanelIds,
  panelsMapToSortedArray,
} from "./utils/group";
import { useWindowSplitterPanelGroupBehavior } from "./hooks/useWindowSplitterBehavior";
import useUniqueId from "./hooks/useUniqueId";

export type CommittedValues = {
  direction: Direction;
  panels: Map<string, PanelData>;
  sizes: number[];
};

export type PanelDataMap = Map<string, PanelData>;

type Props = {
  autoSaveId?: string;
  children?: ReactNode;
  className?: string;
  direction: Direction;
  id?: string | null;
};

// TODO [panels]
// Within an active drag, remember original positions to refine more easily on expand.
// Look at what the Chrome devtools Sources does.

export default function PanelGroup({
  autoSaveId,
  children = null,
  className = "",
  direction,
  id: idFromProps = null,
}: Props) {
  const groupId = useUniqueId(idFromProps);

  const [activeHandleId, setActiveHandleId] = useState<string | null>(null);
  const [panels, setPanels] = useState<PanelDataMap>(new Map());

  // 0-1 values representing the relative size of each panel.
  const [sizes, setSizes] = useState<number[]>([]);

  const dragOffsetRef = useRef<number>(0);

  // Store committed values to avoid unnecessarily re-running memoization/effects functions.
  const committedValuesRef = useRef<CommittedValues>({
    direction,
    panels,
    sizes,
  });

  useLayoutEffect(() => {
    committedValuesRef.current.direction = direction;
    committedValuesRef.current.panels = panels;
    committedValuesRef.current.sizes = sizes;
  });

  useWindowSplitterPanelGroupBehavior({
    committedValuesRef,
    groupId,
    panels,
    setSizes,
    sizes,
  });

  // Once all panels have registered themselves,
  // Compute the initial sizes based on default weights.
  // This assumes that panels register during initial mount (no conditional rendering)!
  useLayoutEffect(() => {
    const sizes = committedValuesRef.current.sizes;
    if (sizes.length === panels.size) {
      return;
    }

    // If this panel has been configured to persist sizing information,
    // default size should be restored from local storage if possible.
    let defaultSizes: number[] | undefined = undefined;
    if (autoSaveId) {
      const panelsArray = panelsMapToSortedArray(panels);
      defaultSizes = loadPanelLayout(autoSaveId, panelsArray);
    }

    if (defaultSizes != null) {
      setSizes(defaultSizes);
    } else {
      const panelsArray = panelsMapToSortedArray(panels);

      let panelsWithNullDefaultSize = 0;
      let totalDefaultSize = 0;
      let totalMinSize = 0;

      panelsArray.forEach((panel) => {
        totalMinSize += panel.minSize;

        if (panel.defaultSize === null) {
          panelsWithNullDefaultSize++;
        } else {
          totalDefaultSize += panel.defaultSize;
        }
      });

      if (totalDefaultSize > 100) {
        throw new Error(
          `The sum of the defaultSize of all panels in a group cannot exceed 100.`
        );
      } else if (totalMinSize > 100) {
        throw new Error(
          `The sum of the minSize of all panels in a group cannot exceed 100.`
        );
      }

      setSizes(
        panelsArray.map((panel) => {
          if (panel.defaultSize === null) {
            return (100 - totalDefaultSize) / panelsWithNullDefaultSize;
          }

          return panel.defaultSize;
        })
      );
    }
  }, [autoSaveId, panels]);

  useEffect(() => {
    // If this panel has been configured to persist sizing information, save sizes to local storage.
    if (autoSaveId) {
      if (sizes.length === 0 || sizes.length !== panels.size) {
        return;
      }

      const panelsArray = panelsMapToSortedArray(panels);
      savePanelGroupLayout(autoSaveId, panelsArray, sizes);
    }
  }, [autoSaveId, panels, sizes]);

  const getPanelStyle = useCallback(
    (id: string): CSSProperties => {
      const { panels } = committedValuesRef.current;

      const size = getFlexGrow(panels, id, sizes);

      return { flexGrow: size };
    },
    [direction, sizes]
  );

  const registerPanel = useCallback((id: string, panel: PanelData) => {
    setPanels((prevPanels) => {
      if (prevPanels.has(id)) {
        return prevPanels;
      }

      const nextPanels = new Map(prevPanels);
      nextPanels.set(id, panel);

      return nextPanels;
    });
  }, []);

  const registerResizeHandle = useCallback(
    (handleId: string) => {
      const resizeHandler = (event: ResizeEvent) => {
        event.preventDefault();

        const {
          direction,
          panels,
          sizes: prevSizes,
        } = committedValuesRef.current;

        const panelsArray = panelsMapToSortedArray(panels);

        const [idBefore, idAfter] = getResizeHandlePanelIds(
          groupId,
          handleId,
          panelsArray
        );
        if (idBefore == null || idAfter == null) {
          return;
        }

        const movement = getMovement(
          event,
          groupId,
          handleId,
          direction,
          dragOffsetRef.current
        );
        if (movement === 0) {
          return;
        }

        const groupElement = getPanelGroup(groupId);
        const rect = groupElement.getBoundingClientRect();
        const isHorizontal = direction === "horizontal";
        const size = isHorizontal ? rect.width : rect.height;
        const delta = (movement / size) * 100;

        const nextSizes = adjustByDelta(
          panels,
          idBefore,
          idAfter,
          delta,
          prevSizes
        );
        if (prevSizes !== nextSizes) {
          setSizes(nextSizes);
        }
      };

      return resizeHandler;
    },
    [groupId]
  );

  const unregisterPanel = useCallback((id: string) => {
    setPanels((prevPanels) => {
      if (!prevPanels.has(id)) {
        return prevPanels;
      }

      const nextPanels = new Map(prevPanels);
      nextPanels.delete(id);

      return nextPanels;
    });
  }, []);

  const panelGroupContext = useMemo(
    () => ({
      direction,
      getPanelStyle,
      groupId,
      registerPanel,
      registerResizeHandle,
      startDragging: (id: string, event: ResizeEvent) => {
        setActiveHandleId(id);

        dragOffsetRef.current = getDragOffset(event, id, direction);
      },
      stopDragging: () => {
        setActiveHandleId(null);
      },
      unregisterPanel,
    }),
    [
      direction,
      getPanelStyle,
      groupId,
      registerPanel,
      registerResizeHandle,
      unregisterPanel,
    ]
  );

  const panelContext = useMemo(
    () => ({
      activeHandleId,
    }),
    [activeHandleId]
  );

  const style: CSSProperties = {
    display: "flex",
    flexDirection: direction === "horizontal" ? "row" : "column",
    height: "100%",
    width: "100%",
  };

  return (
    <PanelContext.Provider value={panelContext}>
      <PanelGroupContext.Provider value={panelGroupContext}>
        <div className={className} data-panel-group-id={groupId} style={style}>
          {children}
        </div>
      </PanelGroupContext.Provider>
    </PanelContext.Provider>
  );
}
