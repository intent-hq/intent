### Component

intentd (backend daemon)

### Description

App crashes on launch with the new build.

### Reproduction steps

```
make run
click the button
```

### Expected vs actual

```
Expected: app opens.
Actual: crash dialog with "thread 'main' panicked".
```

### Version

v1.2.3 (alpha)
